from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import numpy as np
import pandas as pd
import joblib
import os
import json
import psycopg2
import psycopg2.extras
from typing import List, Optional
from dotenv import load_dotenv
import sys
from decimal import Decimal
import datetime as _dt
import warnings

# Suppress scikit-learn version warnings
warnings.filterwarnings('ignore', category=UserWarning, module='sklearn')
# Suppress XGBoost warnings
warnings.filterwarnings('ignore', category=UserWarning, module='xgboost')
warnings.filterwarnings('ignore', message='.*serialized model.*')

# Add utils directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'utils'))
from savings_calculator import calculate_savings, format_savings_message
from feature_engineering import engineer_features, engineer_features_batch, EXPECTED_FEATURES

# CloudOptix enhancement modules
from workload_patterns import detect_workload_pattern
from risk_scoring import calculate_risk_score
from action_steps import generate_action_steps
from cross_family import get_cross_family_recommendations
from special_rules import apply_special_rules
from response_formatter import format_cloudoptix_response

# DB pricing — gracefully degrades to CSV monthly_cost_usd if DB unavailable
try:
    from db_pricing import get_monthly_cost as _db_monthly_cost, get_hourly_price as _db_hourly_price
    _DB_PRICING_AVAILABLE = True
except ImportError:
    _DB_PRICING_AVAILABLE = False
    def _db_monthly_cost(*args, **kwargs): return None
    def _db_hourly_price(*args, **kwargs): return None

# Load .env at startup
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))

# Debug: Print environment variables
print(f"🔍 Environment variables loaded:")
print(f"  POSTGRES_HOST: {os.getenv('POSTGRES_HOST', 'NOT SET')}")
print(f"  POSTGRES_DB: {os.getenv('POSTGRES_DB', 'NOT SET')}")
print(f"  POSTGRES_USER: {os.getenv('POSTGRES_USER', 'NOT SET')}")
print(f"  POSTGRES_PASSWORD: {'SET' if os.getenv('POSTGRES_PASSWORD') else 'NOT SET'}")

# Load ML model and encoder
MODEL_PATH = "cloudoptix_xgb_model.pkl"
ENCODER_PATH = "cloudoptix_xgb_encoder.pkl"
FEATURES_PATH = "cloudoptix_xgb_features.pkl"

# Load model
model = joblib.load(MODEL_PATH)
print(f"✓ Loaded XGBoost model from {MODEL_PATH}")

# Load encoder (used for categorical features if needed)
try:
    encoder = joblib.load(ENCODER_PATH)
    print(f"✓ Loaded encoder from {ENCODER_PATH}")
except FileNotFoundError:
    encoder = None
    print(f"⚠ Encoder file not found, continuing without encoder")

# Load feature names
try:
    feature_names = joblib.load(FEATURES_PATH)
    print(f"✓ Loaded feature names from {FEATURES_PATH}")
except FileNotFoundError:
    feature_names = None
    print(f"⚠ Feature names file not found, using default feature order")

# Set model version
model_version = "v2_cloudoptix_xgb"
print(f"✓ Model version: {model_version}")

# Feature order for ML model (59 engineered features - matches trained model)
# Features are engineered from 12 raw features using feature_engineering module
FEATURE_ORDER = EXPECTED_FEATURES

# FastAPI app
app = FastAPI(title="Cloud VM Optimizer ML Service", version="2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# PostgreSQL config
PG_CONFIG = {
    "host": os.getenv("PG_HOST", "localhost"),
    "port": int(os.getenv("PG_PORT", "5432")),
    "dbname": os.getenv("PG_DB", "cloud_optimizer"),
    "user": os.getenv("PG_USER", "postgres"),
    "password": os.getenv("PG_PASS", ""),
}

def get_pg_connection():
    return psycopg2.connect(**PG_CONFIG, cursor_factory=psycopg2.extras.RealDictCursor)

def decimal_safe(obj):
    """Recursively convert Decimal/datetime to JSON-safe types."""
    if isinstance(obj, dict):
        return {k: decimal_safe(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [decimal_safe(v) for v in obj]
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, (_dt.datetime, _dt.date)):
        return obj.isoformat()
    return obj

# Request schemas
class VMPredictionRequest(BaseModel):
    # Original 12 (required)
    cpu_avg: float = Field(..., ge=0, le=100)
    cpu_p95: float = Field(..., ge=0, le=100)
    memory_avg: float = Field(..., ge=0, le=100)
    memory_p95: float = Field(..., ge=0, le=100)
    disk_read_iops: float = Field(..., ge=0)
    disk_write_iops: float = Field(..., ge=0)
    network_in_bytes: float = Field(..., ge=0)
    network_out_bytes: float = Field(..., ge=0)
    vcpu_count: float = Field(..., ge=0)
    ram_gb: float = Field(..., ge=0)
    uptime_hours: float = Field(..., ge=0)
    cost_per_month: float = Field(..., ge=0)
    
    # New 12 (optional with defaults for backward compatibility)
    cpu_spike_ratio: float = Field(default=1.0, ge=1.0)
    memory_spike_ratio: float = Field(default=1.0, ge=1.0)
    cpu_throttle_percent: float = Field(default=0.0, ge=0, le=100)
    peak_hour_avg_cpu: Optional[float] = Field(default=None, ge=0, le=100)
    off_peak_avg_cpu: Optional[float] = Field(default=None, ge=0, le=100)
    weekend_avg_cpu: Optional[float] = Field(default=None, ge=0, le=100)
    memory_swap_usage: float = Field(default=0.0, ge=0, le=100)
    disk_latency_ms: float = Field(default=10.0, ge=0)
    network_packet_loss: float = Field(default=0.0, ge=0, le=100)
    data_days: int = Field(default=30, ge=1)
    granularity_hourly: int = Field(default=1, ge=0, le=1)
    workload_pattern: int = Field(default=0, ge=0, le=3)
    
    # Metadata (optional for cost calculation and recommendations)
    cloud: Optional[str] = Field(default="aws")
    region: Optional[str] = Field(default="us-east-1")
    instance_type: Optional[str] = Field(default="")

class VMBatchPredictionRequest(BaseModel):
    items: List[VMPredictionRequest]

class CSVBatchItem(BaseModel):
    # Original 12 with defaults
    cpu_avg: float = Field(default=0, ge=0, le=100)
    cpu_p95: float = Field(default=0, ge=0, le=100)
    memory_avg: float = Field(default=0, ge=0, le=100)
    memory_p95: float = Field(default=0, ge=0, le=100)
    disk_read_iops: float = Field(default=0, ge=0)
    disk_write_iops: float = Field(default=0, ge=0)
    network_in_bytes: float = Field(default=0, ge=0)
    network_out_bytes: float = Field(default=0, ge=0)
    vcpu_count: float = Field(default=2, ge=0)
    ram_gb: float = Field(default=4, ge=0)
    uptime_hours: float = Field(default=720, ge=0)
    cost_per_month: float = Field(default=0, ge=0)
    
    # New 12 with defaults
    cpu_spike_ratio: float = Field(default=1.0, ge=1.0)
    memory_spike_ratio: float = Field(default=1.0, ge=1.0)
    cpu_throttle_percent: float = Field(default=0.0, ge=0, le=100)
    peak_hour_avg_cpu: float = Field(default=0.0, ge=0, le=100)
    off_peak_avg_cpu: float = Field(default=0.0, ge=0, le=100)
    weekend_avg_cpu: float = Field(default=0.0, ge=0, le=100)
    memory_swap_usage: float = Field(default=0.0, ge=0, le=100)
    disk_latency_ms: float = Field(default=10.0, ge=0)
    network_packet_loss: float = Field(default=0.0, ge=0, le=100)
    data_days: int = Field(default=30, ge=1)
    granularity_hourly: int = Field(default=1, ge=0, le=1)
    workload_pattern: int = Field(default=0, ge=0, le=3)
    
    # Metadata
    cloud: str = Field(default="aws")
    region: str = Field(default="us-east-1")
    instance_type: str = Field(default="")

class CSVBatchRequest(BaseModel):
    items: List[CSVBatchItem]

# Prediction mapping
_FINDING = {0: "Optimal", 1: "Oversized", 2: "Undersized"}

def map_prediction(pred: int) -> str:
    return {
        0: "Optimal – VM is properly sized",
        1: "Oversized – Consider downsizing",
        2: "Undersized – Consider upgrading"
    }.get(pred, "Unknown")


def detect_anomalies(features: dict) -> dict:
    """
    Detect anomalies before ML prediction (simplified for 12-feature model).
    
    Returns:
        {
            "anomaly_flag": str,
            "recommendation_blocked": bool,
            "anomaly_message": str,
            "confidence_cap": float | None
        }
    """
    cpu_avg = features.get('cpu_avg', 0)
    memory_p95 = features.get('memory_p95', 0)
    uptime_hours = features.get('uptime_hours', 0)
    
    # Check for sustained overload
    if cpu_avg > 95:
        return {
            "anomaly_flag": "sustained_overload",
            "recommendation_blocked": True,
            "anomaly_message": "This instance is critically overloaded. Investigate root cause first.",
            "confidence_cap": None
        }
    
    # Check for memory crisis
    if memory_p95 > 95:
        return {
            "anomaly_flag": "memory_crisis",
            "recommendation_blocked": True,
            "anomaly_message": "Severe memory pressure detected. Upsizing recommended immediately.",
            "confidence_cap": None
        }
    
    # Check for zombie candidate
    if cpu_avg < 1 and uptime_hours > 720:
        return {
            "anomaly_flag": "zombie_candidate",
            "recommendation_blocked": False,
            "anomaly_message": "Instance has been idle for 30+ days. Recommended action: Terminate to save cost.",
            "confidence_cap": None,
            "override_recommendation": "TERMINATE"
        }
    
    # No anomalies detected
    return {
        "anomaly_flag": None,
        "recommendation_blocked": False,
        "anomaly_message": None,
        "confidence_cap": None
    }
    if cpu_spike_ratio > 10:
        return {
            "anomaly_flag": "spike_contamination",
            "recommendation_blocked": False,
            "anomaly_message": "Extreme CPU spike detected in data. Recommendation confidence is capped at 60%.",
            "confidence_cap": 0.6
        }
    
    # No anomaly detected
    return {
        "anomaly_flag": "none",
        "recommendation_blocked": False,
        "anomaly_message": None,
        "confidence_cap": None
    }

# =============================================================================
# COST ESTIMATION FUNCTIONS
# =============================================================================

def estimate_cost_from_specs(cloud: str, vcpu: float, ram_gb: float) -> float:
    """
    Rough cost estimation when pricing unavailable.
    Based on typical cloud pricing patterns as of 2026.
    
    Args:
        cloud: 'aws' | 'azure' | 'gcp'
        vcpu: Number of vCPUs
        ram_gb: RAM in GB
        
    Returns:
        Estimated hourly cost in USD
    """
    if not vcpu or not ram_gb:
        return 0.0
    
    # Rough pricing estimates (USD per hour)
    # These are conservative estimates based on general-purpose instances
    if cloud.lower() == 'aws':
        # AWS: ~$0.05/vCPU + $0.01/GB RAM (m5 family baseline)
        return (vcpu * 0.05) + (ram_gb * 0.01)
    elif cloud.lower() == 'azure':
        # Azure: ~$0.04/vCPU + $0.008/GB RAM (D-series baseline)
        return (vcpu * 0.04) + (ram_gb * 0.008)
    elif cloud.lower() == 'gcp':
        # GCP: ~$0.045/vCPU + $0.009/GB RAM (n2-standard baseline)
        return (vcpu * 0.045) + (ram_gb * 0.009)
    else:
        # Unknown cloud - use AWS pricing as default
        return (vcpu * 0.05) + (ram_gb * 0.01)

def get_fallback_cost(cloud: str, instance_type: str, region: str, os_type: str, 
                     vcpu: float, ram_gb: float, running_hours: float = 720) -> tuple:
    """
    Get fallback cost when database pricing is unavailable.
    
    Returns:
        tuple: (monthly_cost, hourly_rate, price_source)
    """
    # Try to estimate from instance specs
    if vcpu and ram_gb:
        estimated_hourly = estimate_cost_from_specs(cloud, vcpu, ram_gb)
        monthly_cost = round(estimated_hourly * running_hours, 2)
        return monthly_cost, estimated_hourly, "estimated"
    
    # Last resort - return zero with clear indication
    return 0.0, 0.0, "unavailable"

def infer_os_from_instance_type(instance_type: str, cloud: str) -> str:
    """
    Infer OS type from instance type and cloud provider.
    Critical for accurate pricing lookups.
    """
    if not instance_type:
        return 'Linux'

    type_lower = instance_type.lower()
    cloud_lower = cloud.lower()

    # Windows indicators in instance type names
    windows_indicators = [
        'windows', 'win', 'w2016', 'w2019', 'w2022',
        'sqlserver', 'sql', 'iis', 'dotnet', '.net'
    ]

    # Check for Windows indicators
    for indicator in windows_indicators:
        if indicator in type_lower:
            return 'Windows'

    # Cloud-specific patterns
    if cloud_lower == 'azure':
        # Azure Windows VMs sometimes have specific patterns
        # Standard_D8s_v5 (Linux) vs Standard_D8s_v5_Windows (Windows)
        if '_windows' in type_lower or type_lower.endswith('_w'):
            return 'Windows'

        # Azure SQL Server VMs
        if 'sql' in type_lower:
            return 'Windows'

    if cloud_lower == 'aws':
        # AWS Windows instances often use specific families
        # But most are Linux by default unless explicitly Windows
        if 'windows' in type_lower or 'win' in type_lower:
            return 'Windows'

    if cloud_lower == 'gcp':
        # GCP Windows instances have specific naming
        if 'windows' in type_lower or 'win' in type_lower:
            return 'Windows'

    # Default to Linux (most common)
    return 'Linux'

# =============================================================================
# DATABASE QUERY FUNCTIONS - NO MOCK DATA
# =============================================================================

def _lookup_instance(conn, cloud: str, instance_type: str, region: str):
    """
    Look up instance specs + price from PostgreSQL.
    Uses proper table joins - NO MOCK DATA.
    
    Tables used:
    - AWS: aws_instance_sizes + aws_pricing
    - Azure: azure_vm_sizes + azure_vm_pricing  
    - GCP: gcp_vm_sizes + gcp_vm_pricing
    """
    if not conn or not instance_type:
        return None
    
    cloud = cloud.lower()
    try:
        if cloud == "aws":
            # Join aws_instance_sizes with aws_pricing
            sql = """
                SELECT 
                    s.cpu,
                    s.memory_gb,
                    s.architecture,
                    COALESCE(p.price_per_hour, 0) AS price_per_hour
                FROM aws_instance_sizes s
                LEFT JOIN aws_pricing p
                    ON LOWER(TRIM(s.instance_type)) = LOWER(TRIM(p.instance_type))
                    AND LOWER(TRIM(s.region)) = LOWER(TRIM(p.region))
                WHERE LOWER(TRIM(s.instance_type)) = LOWER(TRIM(%s))
                  AND LOWER(TRIM(s.region)) = LOWER(TRIM(%s))
                LIMIT 1
            """
        elif cloud == "azure":
            # Join azure_vm_sizes with azure_vm_pricing
            sql = """
                SELECT 
                    s.cpu,
                    s.memory_gb,
                    COALESCE(p.price_per_hour, 0) AS price_per_hour
                FROM azure_vm_sizes s
                LEFT JOIN azure_vm_pricing p
                    ON LOWER(TRIM(s.vm_size)) = LOWER(TRIM(p.vm_size))
                    AND LOWER(TRIM(s.region)) = LOWER(TRIM(p.region))
                WHERE LOWER(TRIM(s.vm_size)) = LOWER(TRIM(%s))
                  AND LOWER(TRIM(s.region)) = LOWER(TRIM(%s))
                  AND (p.is_spot IS NULL OR p.is_spot = false)
                LIMIT 1
            """
        elif cloud == "gcp":
            # Join gcp_vm_sizes with gcp_vm_pricing
            sql = """
                SELECT 
                    s.cpu,
                    s.memory_gb,
                    COALESCE(p.price_per_hour, 0) AS price_per_hour
                FROM gcp_vm_sizes s
                LEFT JOIN gcp_vm_pricing p
                    ON LOWER(TRIM(s.instance_type)) = LOWER(TRIM(p.instance_type))
                    AND LOWER(TRIM(s.region)) = LOWER(TRIM(p.region))
                WHERE LOWER(TRIM(s.instance_type)) = LOWER(TRIM(%s))
                  AND LOWER(TRIM(s.region)) = LOWER(TRIM(%s))
                LIMIT 1
            """
        else:
            return None
            
        with conn.cursor() as cur:
            cur.execute(sql, (instance_type, region))
            row = cur.fetchone()
            
        if row:
            d = dict(row)
            result = {
                "cpu": float(d["cpu"] or 2),
                "memory_gb": float(d["memory_gb"] or 4),
                "price_per_hour": float(d["price_per_hour"]) if d["price_per_hour"] else None
            }
            if cloud == "aws" and "architecture" in d:
                result["architecture"] = d.get("architecture")
            return result
    except Exception as e:
        print(f"Error looking up instance {instance_type}: {e}")
        try:
            conn.rollback()
        except:
            pass
    return None

def _find_cheaper(conn, cloud: str, instance_type: str, region: str,
                  cpu: float, mem: float, price_hr: float, architecture: str = None):
    """
    Find cheaper alternative instance from database.
    Uses proper table joins - NO MOCK DATA.
    """
    if not conn or not price_hr:
        return None
    
    cloud = cloud.lower()
    try:
        if cloud == "aws":
            if architecture:
                sql = """
                    SELECT 
                        s.instance_type,
                        COALESCE(p.price_per_hour, 0) AS price_per_hour
                    FROM aws_instance_sizes s
                    LEFT JOIN aws_pricing p
                        ON LOWER(TRIM(s.instance_type)) = LOWER(TRIM(p.instance_type))
                        AND LOWER(TRIM(s.region)) = LOWER(TRIM(p.region))
                    WHERE LOWER(TRIM(s.region)) = LOWER(TRIM(%s))
                      AND s.cpu <= %s
                      AND s.memory_gb <= %s
                      AND COALESCE(p.price_per_hour, 999) < %s
                      AND LOWER(TRIM(s.instance_type)) != LOWER(TRIM(%s))
                      AND s.architecture = %s
                    ORDER BY COALESCE(p.price_per_hour, 999) ASC
                    LIMIT 1
                """
                params = (region, cpu, mem, price_hr, instance_type, architecture)
            else:
                sql = """
                    SELECT 
                        s.instance_type,
                        COALESCE(p.price_per_hour, 0) AS price_per_hour
                    FROM aws_instance_sizes s
                    LEFT JOIN aws_pricing p
                        ON LOWER(TRIM(s.instance_type)) = LOWER(TRIM(p.instance_type))
                        AND LOWER(TRIM(s.region)) = LOWER(TRIM(p.region))
                    WHERE LOWER(TRIM(s.region)) = LOWER(TRIM(%s))
                      AND s.cpu <= %s
                      AND s.memory_gb <= %s
                      AND COALESCE(p.price_per_hour, 999) < %s
                      AND LOWER(TRIM(s.instance_type)) != LOWER(TRIM(%s))
                    ORDER BY COALESCE(p.price_per_hour, 999) ASC
                    LIMIT 1
                """
                params = (region, cpu, mem, price_hr, instance_type)
                
        elif cloud == "azure":
            sql = """
                SELECT 
                    s.vm_size AS instance_type,
                    COALESCE(p.price_per_hour, 0) AS price_per_hour
                FROM azure_vm_sizes s
                LEFT JOIN azure_vm_pricing p
                    ON LOWER(TRIM(s.vm_size)) = LOWER(TRIM(p.vm_size))
                    AND LOWER(TRIM(s.region)) = LOWER(TRIM(p.region))
                WHERE LOWER(TRIM(s.region)) = LOWER(TRIM(%s))
                  AND s.cpu <= %s
                  AND s.memory_gb <= %s
                  AND COALESCE(p.price_per_hour, 999) < %s
                  AND LOWER(TRIM(s.vm_size)) != LOWER(TRIM(%s))
                  AND (p.is_spot IS NULL OR p.is_spot = false)
                ORDER BY COALESCE(p.price_per_hour, 999) ASC
                LIMIT 1
            """
            params = (region, cpu, mem, price_hr, instance_type)
            
        elif cloud == "gcp":
            sql = """
                SELECT 
                    s.instance_type,
                    COALESCE(p.price_per_hour, 0) AS price_per_hour
                FROM gcp_vm_sizes s
                LEFT JOIN gcp_vm_pricing p
                    ON LOWER(TRIM(s.instance_type)) = LOWER(TRIM(p.instance_type))
                    AND LOWER(TRIM(s.region)) = LOWER(TRIM(p.region))
                WHERE LOWER(TRIM(s.region)) = LOWER(TRIM(%s))
                  AND s.cpu <= %s
                  AND s.memory_gb <= %s
                  AND COALESCE(p.price_per_hour, 999) < %s
                  AND LOWER(TRIM(s.instance_type)) != LOWER(TRIM(%s))
                ORDER BY COALESCE(p.price_per_hour, 999) ASC
                LIMIT 1
            """
            params = (region, cpu, mem, price_hr, instance_type)
        else:
            return None
            
        with conn.cursor() as cur:
            cur.execute(sql, params)
            row = cur.fetchone()
            
        if row:
            d = dict(row)
            price = float(d["price_per_hour"])
            if price > 0 and price < price_hr:
                return {"instance_type": d["instance_type"], "price_per_hour": price}
    except Exception as e:
        print(f"Error finding cheaper instance: {e}")
        try:
            conn.rollback()
        except:
            pass
    return None

def _find_bigger(conn, cloud: str, instance_type: str, region: str,
                 cpu: float, mem: float, price_hr: float, architecture: str = None):
    """
    Find larger alternative instance from database.
    Uses proper table joins - NO MOCK DATA.
    """
    if not conn:
        return None
    
    cloud = cloud.lower()
    try:
        if cloud == "aws":
            if architecture:
                sql = """
                    SELECT 
                        s.instance_type,
                        COALESCE(p.price_per_hour, 0) AS price_per_hour
                    FROM aws_instance_sizes s
                    LEFT JOIN aws_pricing p
                        ON LOWER(TRIM(s.instance_type)) = LOWER(TRIM(p.instance_type))
                        AND LOWER(TRIM(s.region)) = LOWER(TRIM(p.region))
                    WHERE LOWER(TRIM(s.region)) = LOWER(TRIM(%s))
                      AND (s.cpu > %s OR s.memory_gb > %s)
                      AND COALESCE(p.price_per_hour, 0) > %s
                      AND LOWER(TRIM(s.instance_type)) != LOWER(TRIM(%s))
                      AND s.architecture = %s
                    ORDER BY COALESCE(p.price_per_hour, 999) ASC
                    LIMIT 1
                """
                params = (region, cpu, mem, price_hr, instance_type, architecture)
            else:
                sql = """
                    SELECT 
                        s.instance_type,
                        COALESCE(p.price_per_hour, 0) AS price_per_hour
                    FROM aws_instance_sizes s
                    LEFT JOIN aws_pricing p
                        ON LOWER(TRIM(s.instance_type)) = LOWER(TRIM(p.instance_type))
                        AND LOWER(TRIM(s.region)) = LOWER(TRIM(p.region))
                    WHERE LOWER(TRIM(s.region)) = LOWER(TRIM(%s))
                      AND (s.cpu > %s OR s.memory_gb > %s)
                      AND COALESCE(p.price_per_hour, 0) > %s
                      AND LOWER(TRIM(s.instance_type)) != LOWER(TRIM(%s))
                    ORDER BY COALESCE(p.price_per_hour, 999) ASC
                    LIMIT 1
                """
                params = (region, cpu, mem, price_hr, instance_type)
                
        elif cloud == "azure":
            sql = """
                SELECT 
                    s.vm_size AS instance_type,
                    COALESCE(p.price_per_hour, 0) AS price_per_hour
                FROM azure_vm_sizes s
                LEFT JOIN azure_vm_pricing p
                    ON LOWER(TRIM(s.vm_size)) = LOWER(TRIM(p.vm_size))
                    AND LOWER(TRIM(s.region)) = LOWER(TRIM(p.region))
                WHERE LOWER(TRIM(s.region)) = LOWER(TRIM(%s))
                  AND (s.cpu > %s OR s.memory_gb > %s)
                  AND COALESCE(p.price_per_hour, 0) > %s
                  AND LOWER(TRIM(s.vm_size)) != LOWER(TRIM(%s))
                  AND (p.is_spot IS NULL OR p.is_spot = false)
                ORDER BY COALESCE(p.price_per_hour, 999) ASC
                LIMIT 1
            """
            params = (region, cpu, mem, price_hr, instance_type)
            
        elif cloud == "gcp":
            sql = """
                SELECT 
                    s.instance_type,
                    COALESCE(p.price_per_hour, 0) AS price_per_hour
                FROM gcp_vm_sizes s
                LEFT JOIN gcp_vm_pricing p
                    ON LOWER(TRIM(s.instance_type)) = LOWER(TRIM(p.instance_type))
                    AND LOWER(TRIM(s.region)) = LOWER(TRIM(p.region))
                WHERE LOWER(TRIM(s.region)) = LOWER(TRIM(%s))
                  AND (s.cpu > %s OR s.memory_gb > %s)
                  AND COALESCE(p.price_per_hour, 0) > %s
                  AND LOWER(TRIM(s.instance_type)) != LOWER(TRIM(%s))
                ORDER BY COALESCE(p.price_per_hour, 999) ASC
                LIMIT 1
            """
            params = (region, cpu, mem, price_hr, instance_type)
        else:
            return None
            
        with conn.cursor() as cur:
            cur.execute(sql, params)
            row = cur.fetchone()
            
        if row:
            d = dict(row)
            price = float(d["price_per_hour"])
            if price > 0:
                return {"instance_type": d["instance_type"], "price_per_hour": price}
    except Exception as e:
        print(f"Error finding bigger instance: {e}")
        try:
            conn.rollback()
        except:
            pass
    return None

# =============================================================================
# API ENDPOINTS
# =============================================================================

@app.get("/health")
def health():
    pg_ok = False
    try:
        conn = get_pg_connection()
        conn.close()
        pg_ok = True
    except Exception:
        pass
    return {
        "status": "ok",
        "model_loaded": True,
        "postgres_connected": pg_ok
    }

@app.post("/predict/vm")
def predict_vm(request: VMPredictionRequest):
    try:
        data = request.dict()
        
        # Engineer features from raw 12 features to 59 features
        engineered_features = engineer_features(data)
        
        # Detect anomalies using raw features
        anomaly_result = detect_anomalies(data)
        
        # If zombie candidate, override recommendation
        if anomaly_result.get("override_recommendation") == "TERMINATE":
            return {
                "prediction": 3,  # Use 3 for ZOMBIE even though model doesn't have it
                "confidence": 0.95,
                "recommendation": "ZOMBIE – Consider terminating (low utilization, high uptime)",
                "data_quality": "high",
                "data_days": data.get('data_days', 30),
                "granularity": "hourly" if data.get('granularity_hourly', 1) == 1 else "daily",
                "model_version": model_version,
                "anomaly_flag": anomaly_result["anomaly_flag"],
                "recommendation_blocked": anomaly_result["recommendation_blocked"],
                "anomaly_message": anomaly_result["anomaly_message"]
            }
        
        # If recommendation blocked, return error
        if anomaly_result["recommendation_blocked"]:
            return {
                "prediction": -1,
                "confidence": 0.0,
                "recommendation": "BLOCKED",
                "data_quality": "high",
                "data_days": data.get('data_days', 30),
                "granularity": "hourly" if data.get('granularity_hourly', 1) == 1 else "daily",
                "model_version": model_version,
                "anomaly_flag": anomaly_result["anomaly_flag"],
                "recommendation_blocked": anomaly_result["recommendation_blocked"],
                "anomaly_message": anomaly_result["anomaly_message"]
            }
        
        # Construct feature vector as DataFrame with proper column names
        features_df = pd.DataFrame([engineered_features])[FEATURE_ORDER]
        
        # Run prediction directly (no scaling needed for XGBoost)
        prediction = int(model.predict(features_df)[0])
        probabilities = model.predict_proba(features_df)[0]
        model_confidence = float(max(probabilities))
        
        # Calculate data quality factor (always high for now)
        data_quality_factor, data_quality_label = 1.0, "high"
        
        # Adjust confidence
        final_confidence = model_confidence * data_quality_factor
        
        # Apply confidence cap if spike contamination
        if anomaly_result["confidence_cap"] is not None:
            final_confidence = min(final_confidence, anomaly_result["confidence_cap"])
        
        # Round to 3 decimal places
        final_confidence = round(final_confidence, 3)
        
        return {
            "prediction": prediction,
            "confidence": final_confidence,
            "recommendation": map_prediction(prediction),
            "data_quality": data_quality_label,
            "data_days": data.get('data_days', 30),
            "granularity": "hourly" if data.get('granularity_hourly', 1) == 1 else "daily",
            "model_version": model_version,
            "anomaly_flag": anomaly_result["anomaly_flag"],
            "recommendation_blocked": anomaly_result["recommendation_blocked"],
            "anomaly_message": anomaly_result["anomaly_message"]
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/predict/vm/batch")
def predict_vm_batch(request: VMBatchPredictionRequest):
    try:
        print(f"Received batch request with {len(request.items)} items")
        
        # Build list of raw data dictionaries
        rows_data = []
        for i, item in enumerate(request.items):
            try:
                data = item.dict()
                rows_data.append(data)
            except Exception as e:
                print(f"Error processing item {i}: {e}")
                print(f"Item data: {item.dict()}")
                raise
        
        # Engineer features for all rows at once
        features_df = engineer_features_batch(rows_data)
        print(f"Created engineered DataFrame with shape: {features_df.shape}")
        
        # Run predictions directly (no scaling needed for XGBoost)
        preds = model.predict(features_df)
        probs = model.predict_proba(features_df)
        print(f"Predictions completed: {len(preds)} results")
        
        # Connect to database for pricing lookup
        try:
            conn = get_pg_connection()
        except Exception as e:
            print(f"Database connection failed: {e}")
            conn = None
        
        results = []
        for i, item in enumerate(request.items):
            try:
                pred = int(preds[i])
                model_confidence = float(max(probs[i]))
                
                data = item.dict()
                
                # Calculate data quality factor (always high for now)
                data_quality_factor, data_quality_label = 1.0, "high"
                final_confidence = round(model_confidence * data_quality_factor, 3)
                
                # Detect anomalies
                anomaly_result = detect_anomalies(data)
                
                # Apply confidence cap if needed
                if anomaly_result.get("confidence_cap") is not None:
                    final_confidence = min(final_confidence, anomaly_result["confidence_cap"])
                    final_confidence = round(final_confidence, 3)
                
                finding = _FINDING.get(pred, "Optimal")
                
                cloud = (data.get("cloud") or "aws").lower()
                region = data.get("region") or "us-east-1"
                itype = data.get("instance_type") or ""
                csv_cost = data.get("cost_per_month", 0)
                
                # Look up instance specs and pricing from database
                db_info = _lookup_instance(conn, cloud, itype, region) if conn else None
                current_cpu = db_info["cpu"] if db_info else (data.get("vcpu_count") or 2)
                current_mem = db_info["memory_gb"] if db_info else (data.get("ram_gb") or 4)
                db_price_hr = db_info["price_per_hour"] if db_info else None
                current_arch = db_info.get("architecture") if db_info else None
                
                # Determine current cost
                if csv_cost > 0:
                    current_cost_month = csv_cost
                    current_price_hr = db_price_hr if db_price_hr else csv_cost / 730
                elif db_price_hr and db_price_hr > 0:
                    current_price_hr = db_price_hr
                    current_cost_month = round(db_price_hr * 730, 2)
                else:
                    # No pricing data available
                    current_price_hr = 0
                    current_cost_month = 0
                
                recommended_type = itype
                rec_cost = current_cost_month
                rec_price_hr = current_price_hr
                
                # Find recommendations based on ML prediction
                if finding == "Oversized" and current_price_hr > 0 and conn:
                    alt = _find_cheaper(conn, cloud, itype, region,
                                        current_cpu, current_mem, current_price_hr, current_arch)
                    if alt:
                        recommended_type = alt["instance_type"]
                        rec_price_hr = alt["price_per_hour"]
                        rec_cost = rec_price_hr * 730
                    else:
                        # No cheaper instance found - mark as Optimal instead of Oversized
                        finding = "Optimal"
                        recommended_type = itype
                        rec_price_hr = current_price_hr
                        rec_cost = current_cost_month
                        
                elif finding == "Undersized" and current_price_hr > 0 and conn:
                    alt = _find_bigger(conn, cloud, itype, region,
                                       current_cpu, current_mem, current_price_hr, current_arch)
                    if alt:
                        recommended_type = alt["instance_type"]
                        rec_price_hr = alt["price_per_hour"]
                        rec_cost = rec_price_hr * 730
                    else:
                        # No bigger instance found - mark as Optimal instead of Undersized
                        finding = "Optimal"
                        recommended_type = itype
                        rec_price_hr = current_price_hr
                        rec_cost = current_cost_month
                
                optimized_cost_month = round(rec_cost, 2)
                
                # Calculate savings
                savings_data = calculate_savings(current_price_hr, rec_price_hr)
                savings = savings_data["savings_per_month"]
                
                # Build recommendation text
                rec_text = format_savings_message(finding, itype, recommended_type, savings_data)
                
                results.append({
                    "prediction": pred,
                    "finding": finding,
                    "confidence": final_confidence,
                    "recommendedType": recommended_type,
                    "currentCostPerMonth": round(current_cost_month, 2),
                    "optimizedCostPerMonth": optimized_cost_month,
                    "savings": savings,
                    "recommendation": rec_text,
                    "data_quality": data_quality_label,
                    "data_days": data.get('data_days', 30),
                    "granularity": "hourly" if data.get('granularity_hourly', 1) == 1 else "daily",
                    "model_version": model_version,
                    "anomaly_flag": anomaly_result.get("anomaly_flag"),
                    "recommendation_blocked": anomaly_result.get("recommendation_blocked", False),
                    "anomaly_message": anomaly_result.get("anomaly_message")
                })
            except Exception as e:
                print(f"Error processing result {i}: {e}")
                raise
        
        if conn:
            try:
                conn.close()
            except:
                pass
        
        print(f"Returning {len(results)} results")
        return {"count": len(results), "results": results}
    except Exception as e:
        print(f"ERROR in predict_vm_batch: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Prediction error: {str(e)}")

@app.post("/predict/csv/batch")
def predict_csv_batch(request: CSVBatchRequest):
    """
    CSV batch endpoint with PostgreSQL pricing lookup.
    NO MOCK DATA - all data comes from database tables.
    Uses feature engineering to transform 12 raw features to 59 engineered features.
    """
    try:
        # Check batch size limits
        if len(request.items) > 50000:
            raise HTTPException(
                status_code=413,
                detail="Batch too large. Maximum 50,000 instances per upload. Please split your file and upload in parts."
            )
        
        # Prepare raw data for feature engineering
        raw_data_list = []
        for item in request.items:
            d = item.dict()
            raw_data_list.append(d)
        
        # Engineer features for all rows at once
        features_df = engineer_features_batch(raw_data_list)
        
        # Run predictions directly (no scaling needed for XGBoost)
        preds = model.predict(features_df)
        probs = model.predict_proba(features_df)
        
        # Connect to database
        try:
            conn = get_pg_connection()
        except Exception as e:
            print(f"Database connection failed: {e}")
            conn = None
        
        results = []
        for i, item in enumerate(request.items):
            pred = int(preds[i])
            model_confidence = float(max(probs[i]))
            
            # Get feature data
            d = item.dict()
            
            # Calculate data quality factor (always high for now)
            data_quality_factor, data_quality_label = 1.0, "high"
            confidence = round(model_confidence * data_quality_factor, 3)
            
            # Detect anomalies
            anomaly_result = detect_anomalies(d)
            
            # Apply confidence cap if needed
            if anomaly_result["confidence_cap"] is not None:
                confidence = min(confidence, anomaly_result["confidence_cap"])
                confidence = round(confidence, 3)
            
            finding = _FINDING.get(pred, "Optimal")
            
            cloud = (d.get("cloud") or "aws").lower()
            region = d.get("region") or "us-east-1"
            itype = d.get("instance_type") or ""
            csv_cost = d.get("cost_per_month", 0)
            
            # Look up instance specs and pricing from database
            db_info = _lookup_instance(conn, cloud, itype, region)
            current_cpu = db_info["cpu"] if db_info else (d.get("vcpu_count") or 2)
            current_mem = db_info["memory_gb"] if db_info else (d.get("ram_gb") or 4)
            db_price_hr = db_info["price_per_hour"] if db_info else None
            current_arch = db_info.get("architecture") if db_info else None
            
            # Determine current cost - Try DB pricing first, then CSV, then fallback
            os_type = d.get("os_type")
            if not os_type:
                # Infer OS from instance type when not provided
                inferred_os = infer_os_from_instance_type(itype, cloud)
                os_type = inferred_os
                d["os_type"] = os_type  # Update the item dictionary
                print(f"OS inferred for {itype}: {inferred_os}")
            elif os_type.lower() == 'linux':
                # Check if Linux default should be overridden with Windows
                inferred_os = infer_os_from_instance_type(itype, cloud)
                if inferred_os == 'Windows':
                    os_type = inferred_os
                    d["os_type"] = os_type  # Update the item dictionary
                    print(f"OS overridden for {itype}: Linux → {inferred_os}")
            
            running_hours = d.get("uptime_hours", 720)
            
            if _DB_PRICING_AVAILABLE:
                # Try to get real price from db_pricing module
                db_monthly = _db_monthly_cost(cloud, itype, region, os_type, running_hours)
                db_hourly = _db_hourly_price(cloud, itype, region, os_type)
                
                if db_monthly is not None and db_hourly is not None:
                    current_cost_month = db_monthly
                    current_price_hr = db_hourly
                elif csv_cost > 0:
                    current_cost_month = csv_cost
                    current_price_hr = csv_cost / running_hours
                elif db_price_hr and db_price_hr > 0:
                    current_price_hr = db_price_hr
                    current_cost_month = round(db_price_hr * running_hours, 2)
                else:
                    # Use fallback cost estimation
                    fallback_monthly, fallback_hourly, price_source = get_fallback_cost(
                        cloud, itype, region, os_type, current_cpu, current_mem, running_hours
                    )
                    current_cost_month = fallback_monthly
                    current_price_hr = fallback_hourly
                    if fallback_hourly and fallback_hourly > 0:
                        print(f"Using fallback pricing for {itype}: ${fallback_hourly:.4f}/hr (source: {price_source})")
            else:
                # Fallback to original logic when db_pricing unavailable
                if csv_cost > 0:
                    current_cost_month = csv_cost
                    current_price_hr = csv_cost / running_hours
                elif db_price_hr and db_price_hr > 0:
                    current_price_hr = db_price_hr
                    current_cost_month = round(db_price_hr * running_hours, 2)
                else:
                    # Use fallback cost estimation
                    fallback_monthly, fallback_hourly, price_source = get_fallback_cost(
                        cloud, itype, region, os_type, current_cpu, current_mem, running_hours
                    )
                    current_cost_month = fallback_monthly
                    current_price_hr = fallback_hourly
                    if fallback_hourly and fallback_hourly > 0:
                        print(f"Using fallback pricing for {itype}: ${fallback_hourly:.4f}/hr (source: {price_source})")
            
            recommended_type = itype
            rec_cost = current_cost_month
            rec_price_hr = current_price_hr
            
            # Find recommendations based on ML prediction
            if finding == "Oversized" and current_price_hr > 0 and conn:
                alt = _find_cheaper(conn, cloud, itype, region,
                                    current_cpu, current_mem, current_price_hr, current_arch)
                if alt:
                    recommended_type = alt["instance_type"]
                    rec_price_hr = alt["price_per_hour"]
                    rec_cost = rec_price_hr * running_hours
                    
                    # Override with DB pricing if available
                    if _DB_PRICING_AVAILABLE:
                        db_rec_monthly = _db_monthly_cost(cloud, recommended_type, region, os_type, running_hours)
                        db_rec_hourly = _db_hourly_price(cloud, recommended_type, region, os_type)
                        if db_rec_monthly is not None and db_rec_hourly is not None:
                            rec_cost = db_rec_monthly
                            rec_price_hr = db_rec_hourly
                        else:
                            # Use fallback for recommended instance
                            rec_specs = _lookup_instance(conn, cloud, recommended_type, region)
                            if rec_specs:
                                fallback_monthly, fallback_hourly, _ = get_fallback_cost(
                                    cloud, recommended_type, region, os_type, 
                                    rec_specs["cpu"], rec_specs["memory_gb"], running_hours
                                )
                                rec_cost = fallback_monthly
                                rec_price_hr = fallback_hourly
                else:
                    # No cheaper instance found - mark as Optimal instead of Oversized
                    finding = "Optimal"
                    recommended_type = itype
                    rec_price_hr = current_price_hr
                    rec_cost = current_cost_month
                    
            elif finding == "Undersized" and current_price_hr > 0 and conn:
                alt = _find_bigger(conn, cloud, itype, region,
                                   current_cpu, current_mem, current_price_hr, current_arch)
                if alt:
                    recommended_type = alt["instance_type"]
                    rec_price_hr = alt["price_per_hour"]
                    rec_cost = rec_price_hr * running_hours
                    
                    # Override with DB pricing if available
                    if _DB_PRICING_AVAILABLE:
                        db_rec_monthly = _db_monthly_cost(cloud, recommended_type, region, os_type, running_hours)
                        db_rec_hourly = _db_hourly_price(cloud, recommended_type, region, os_type)
                        if db_rec_monthly is not None and db_rec_hourly is not None:
                            rec_cost = db_rec_monthly
                            rec_price_hr = db_rec_hourly
                        else:
                            # Use fallback for recommended instance
                            rec_specs = _lookup_instance(conn, cloud, recommended_type, region)
                            if rec_specs:
                                fallback_monthly, fallback_hourly, _ = get_fallback_cost(
                                    cloud, recommended_type, region, os_type, 
                                    rec_specs["cpu"], rec_specs["memory_gb"], running_hours
                                )
                                rec_cost = fallback_monthly
                                rec_price_hr = fallback_hourly
                else:
                    # No bigger instance found - mark as Optimal instead of Undersized
                    finding = "Optimal"
                    recommended_type = itype
                    rec_price_hr = current_price_hr
                    rec_cost = current_cost_month
            
            optimized_cost_month = round(rec_cost, 2)
            
            # Calculate savings
            savings_data = calculate_savings(current_price_hr, rec_price_hr)
            savings = savings_data["savings_per_month"]
            
            # ===== CloudOptix Enhancement Layer =====
            
            # 1. Detect workload pattern
            pattern_data = detect_workload_pattern(
                cpu_avg=d.get('cpu_avg', 0),
                cpu_p95=d.get('cpu_p95', 0),
                mem_avg=d.get('memory_avg', 0),
                mem_p95=d.get('memory_p95', 0),
                os_type=d.get('os_type')
            )
            
            # 2. Map ML finding to recommendation
            recommendation_map = {
                "Optimal": "KEEP",
                "Oversized": "DOWNSIZE",
                "Undersized": "UPSIZE"
            }
            recommendation = recommendation_map.get(finding, "KEEP")
            
            # 3. Apply special rules (may override recommendation)
            reasons = []
            recommendation, reasons = apply_special_rules(
                ml_recommendation=recommendation,
                pattern_key=pattern_data['pattern_key'],
                cpu_avg=d.get('cpu_avg', 0),
                mem_avg=d.get('memory_avg', 0),
                cpu_p95=d.get('cpu_p95', 0),
                reasons=reasons
            )
            
            # Add default reasons if none from special rules
            if not reasons:
                if recommendation == "DOWNSIZE":
                    reasons.append(f"CPU utilization averaging {d.get('cpu_avg', 0):.1f}% indicates oversizing")
                    reasons.append(f"Memory utilization averaging {d.get('memory_avg', 0):.1f}%")
                elif recommendation == "UPSIZE":
                    reasons.append(f"High resource utilization detected")
                    reasons.append(f"CPU peaks at {d.get('cpu_p95', 0):.1f}%")
                else:
                    reasons.append("Instance is optimally sized for current workload")
            
            # Add workload pattern to reasons
            if pattern_data and pattern_data.get('workload_pattern'):
                reasons.append(f"Workload pattern: {pattern_data['workload_pattern']}")
            else:
                reasons.append("Workload pattern: Unknown")
            
            # 4. Calculate risk score
            risk_data = calculate_risk_score(
                recommendation=recommendation,
                cpu_avg=d.get('cpu_avg', 0),
                cpu_p95=d.get('cpu_p95', 0),
                mem_avg=d.get('memory_avg', 0),
                mem_p95=d.get('memory_p95', 0),
                confidence=confidence,
                pattern_key=pattern_data['pattern_key']
            )
            
            # 5. Generate action steps
            action_steps = generate_action_steps(
                recommendation=recommendation,
                current_instance=itype,
                target_instance=recommended_type if recommended_type else itype,
                monthly_saving=savings,
                cloud_provider=cloud
            )
            
            # 6. Get cross-family recommendations
            cross_family = get_cross_family_recommendations(
                pattern_key=pattern_data['pattern_key'],
                current_instance=itype,
                cloud_provider=cloud
            )
            
            # 7. Format CloudOptix response
            cloudoptix_response = format_cloudoptix_response(
                item=d,
                ml_prediction=pred,
                ml_probabilities=probs[i],
                confidence=confidence,
                current_instance=itype,
                target_instance=recommended_type if recommended_type else itype,
                current_cost=current_cost_month,
                target_cost=optimized_cost_month,
                pattern_data=pattern_data,
                risk_data=risk_data,
                action_steps=action_steps,
                cross_family=cross_family,
                reasons=reasons,
                recommendation=recommendation  # Pass the computed recommendation
            )
            
            results.append(cloudoptix_response)
        
        if conn:
            try:
                conn.close()
            except:
                pass
        
        return {"count": len(results), "results": results}
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/pipeline/run")
def pipeline_run():
    """Trigger the full ML inference pipeline."""
    try:
        from pg_inference_pipeline import run_pipeline
        summary = run_pipeline()
        return decimal_safe({"success": True, **summary})
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Pipeline error: {str(e)}")

@app.get("/pipeline/predictions")
def pipeline_predictions(
    cloud: Optional[str] = Query(None, description="Filter by cloud: aws | azure | gcp"),
    prediction: Optional[str] = Query(None, description="Filter by prediction: OVERSIZED | UNDERSIZED | OPTIMAL")
):
    """Return all rows from vm_sizing_predictions."""
    try:
        conn = get_pg_connection()
        where_clauses = []
        params = []
        
        if cloud:
            where_clauses.append("LOWER(cloud) = LOWER(%s)")
            params.append(cloud)
        if prediction:
            where_clauses.append("UPPER(prediction) = UPPER(%s)")
            params.append(prediction)
        
        where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
        sql = f"SELECT * FROM vm_sizing_predictions {where_sql} ORDER BY predicted_at DESC"
        
        with conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
        conn.close()
        
        records = decimal_safe([dict(r) for r in rows])
        
        counts = {
            "oversized": sum(1 for r in records if r["prediction"] == "OVERSIZED"),
            "undersized": sum(1 for r in records if r["prediction"] == "UNDERSIZED"),
            "optimal": sum(1 for r in records if r["prediction"] == "OPTIMAL"),
        }
        return {"total": len(records), "counts": counts, "predictions": records}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
