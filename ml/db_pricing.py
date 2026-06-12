"""
db_pricing.py
Fetches real hourly prices from the cloud_optimizer PostgreSQL database.
Used by recommendation_engine.py to calculate accurate savings.

Tables used:
  AWS:   aws_pricing        (columns: region, instance_type, os, tenancy, billing_type, price_per_hour)
  Azure: azure_vm_pricing   (columns: region, vm_size, price_per_hour, is_spot, os)
  GCP:   gcp_vm_pricing     (columns: instance_type, region, os, price_per_hour)
"""

import os
import logging
from functools import lru_cache
from typing import Optional

logger = logging.getLogger(__name__)

# ── DB connection ──────────────────────────────────────────────────────────────
# Reads from environment variables. Set these before running the backend:
#   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
# Falls back to direct monthly_cost_usd if DB is unavailable (safe degradation).

_conn = None

def _get_conn():
    global _conn
    if _conn is not None:
        try:
            _conn.cursor().execute("SELECT 1")
            return _conn
        except Exception:
            _conn = None
    
    try:
        import psycopg2
        _conn = psycopg2.connect(
            host=os.environ.get("POSTGRES_HOST", "localhost"),
            port=int(os.environ.get("POSTGRES_PORT", 5432)),
            dbname=os.environ.get("POSTGRES_DB", "cloud_optimizer"),
            user=os.environ.get("POSTGRES_USER", "postgres"),
            password=os.environ.get("POSTGRES_PASSWORD", ""),
            connect_timeout=3,
        )
        _conn.autocommit = True
        logger.info("db_pricing: connected to cloud_optimizer DB")
        return _conn
    except Exception as e:
        logger.warning(f"db_pricing: DB unavailable ({e}) — will use CSV monthly_cost_usd")
        return None


# ── OS normalisation ───────────────────────────────────────────────────────────

def _normalise_os(os_type: str, cloud: str) -> str:
    """
    Map os_type strings from the CSV to the OS values stored in each DB table.
    
    AWS aws_pricing.os values:  Linux, Windows, Red Hat Enterprise Linux,
                                SUSE Linux, Ubuntu, Debian
    Azure azure_vm_pricing.os:  Linux, Windows
    GCP gcp_vm_pricing.os:      Linux, Windows
    """
    s = (os_type or "").lower()
    if "windows" in s:
        return "Windows"
    if cloud == "aws":
        if "red hat" in s or "rhel" in s:
            return "Red Hat Enterprise Linux"
        if "suse" in s:
            return "SUSE Linux"
        if "ubuntu" in s:
            return "Ubuntu"
        if "debian" in s:
            return "Debian"
        return "Linux"  # Amazon Linux, CentOS, CoreOS, etc.
    # Azure and GCP: just Linux or Windows
    return "Linux"


# ── Price lookup functions ─────────────────────────────────────────────────────

@lru_cache(maxsize=8192)
def _fetch_aws_price(region: str, instance_type: str, os_str: str) -> Optional[float]:
    conn = _get_conn()
    if not conn:
        return None
    try:
        cur = conn.cursor()
        # Try exact OS match first, then fallback to Linux
        # Note: billing_type is lowercase in database
        cur.execute("""
            SELECT price_per_hour
            FROM aws_pricing
            WHERE region        = %s
              AND instance_type = %s
              AND os            = %s
              AND LOWER(billing_type) = 'on-demand'
            ORDER BY price_per_hour
            LIMIT 1
        """, (region, instance_type, os_str))
        row = cur.fetchone()
        if row:
            return float(row[0])
        # Fallback: Linux price
        cur.execute("""
            SELECT price_per_hour
            FROM aws_pricing
            WHERE region        = %s
              AND instance_type = %s
              AND os            = 'Linux'
              AND LOWER(billing_type) = 'on-demand'
            ORDER BY price_per_hour
            LIMIT 1
        """, (region, instance_type))
        row = cur.fetchone()
        return float(row[0]) if row else None
    except Exception as e:
        logger.warning(f"_fetch_aws_price({instance_type}, {region}): {e}")
        return None


@lru_cache(maxsize=8192)
def _fetch_azure_price(region: str, vm_size: str, os_str: str) -> Optional[float]:
    conn = _get_conn()
    if not conn:
        return None
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT price_per_hour
            FROM azure_vm_pricing
            WHERE region  = %s
              AND vm_size = %s
              AND os      = %s
              AND is_spot = FALSE
            ORDER BY price_per_hour
            LIMIT 1
        """, (region, vm_size, os_str))
        row = cur.fetchone()
        if row:
            return float(row[0])
        # Fallback: any OS
        cur.execute("""
            SELECT price_per_hour
            FROM azure_vm_pricing
            WHERE region  = %s
              AND vm_size = %s
              AND is_spot = FALSE
            ORDER BY price_per_hour
            LIMIT 1
        """, (region, vm_size))
        row = cur.fetchone()
        return float(row[0]) if row else None
    except Exception as e:
        logger.warning(f"_fetch_azure_price({vm_size}, {region}): {e}")
        return None


@lru_cache(maxsize=8192)
def _fetch_gcp_price(region: str, instance_type: str, os_str: str) -> Optional[float]:
    conn = _get_conn()
    if not conn:
        return None
    try:
        cur = conn.cursor()
        cur.execute("""
            SELECT price_per_hour
            FROM gcp_vm_pricing
            WHERE region        = %s
              AND instance_type = %s
              AND os            = %s
            ORDER BY price_per_hour
            LIMIT 1
        """, (region, instance_type, os_str))
        row = cur.fetchone()
        if row:
            return float(row[0])
        # Fallback: Linux
        cur.execute("""
            SELECT price_per_hour
            FROM gcp_vm_pricing
            WHERE region        = %s
              AND instance_type = %s
              AND os            = 'Linux'
            ORDER BY price_per_hour
            LIMIT 1
        """, (region, instance_type))
        row = cur.fetchone()
        return float(row[0]) if row else None
    except Exception as e:
        logger.warning(f"_fetch_gcp_price({instance_type}, {region}): {e}")
        return None


# ── Public API ─────────────────────────────────────────────────────────────────

def get_hourly_price(cloud: str, instance_type: str, region: str,
                     os_type: str) -> Optional[float]:
    """
    Return the on-demand hourly price for the given instance.
    Returns None if DB is unreachable or instance not found.
    
    Args:
        cloud:         'aws' | 'azure' | 'gcp'
        instance_type: e.g. 'm5.2xlarge', 'Standard_D8s_v5', 'n2-standard-16'
        region:        e.g. 'us-east-1', 'eastus', 'us-central1'
        os_type:       Raw OS string from CSV, e.g. 'Ubuntu 22.04 LTS'
    """
    os_str = _normalise_os(os_type, cloud)
    c = cloud.lower()
    if c == "aws":
        return _fetch_aws_price(region, instance_type, os_str)
    elif c == "azure":
        return _fetch_azure_price(region, instance_type, os_str)
    elif c == "gcp":
        return _fetch_gcp_price(region, instance_type, os_str)
    return None


def get_monthly_cost(cloud: str, instance_type: str, region: str,
                     os_type: str, running_hours: float = 720.0) -> Optional[float]:
    """
    Return the estimated monthly cost for the given instance.
    monthly_cost = price_per_hour × running_hours
    
    Returns None if price not found in DB.
    """
    hourly = get_hourly_price(cloud, instance_type, region, os_type)
    if hourly is None:
        return None
    return round(hourly * running_hours, 2)


def clear_cache():
    """Call this to invalidate the LRU price cache (e.g. after DB refresh)."""
    _fetch_aws_price.cache_clear()
    _fetch_azure_price.cache_clear()
    _fetch_gcp_price.cache_clear()
