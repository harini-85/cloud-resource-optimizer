"""
CloudOptix Response Formatter

This module transforms ML service output to CloudOptix format specification.
Assembles all components (patterns, risk, actions, cross-family) into a unified response.
"""

from datetime import datetime
from typing import Dict, List, Tuple, Any


def format_cloudoptix_response(
    item: Dict[str, Any],
    ml_prediction: int,
    ml_probabilities: List[float],
    confidence: float,
    current_instance: str,
    target_instance: str,
    current_cost: float,
    target_cost: float,
    pattern_data: Dict[str, str],
    risk_data: Dict,
    action_steps: List[str],
    cross_family: List[List[str]],
    reasons: List[str],
    recommendation: str = None  # Add recommendation parameter
) -> Dict[str, Any]:
    """
    Format ML service output to CloudOptix specification.
    
    Args:
        item: Original CSV item with instance metadata
        ml_prediction: ML model prediction (0=Optimal, 1=Oversized, 2=Undersized)
        ml_probabilities: Prediction probabilities [downsize, keep, upsize]
        confidence: Prediction confidence (0-1 or 0-100)
        current_instance: Current instance type
        target_instance: Recommended instance type
        current_cost: Current monthly cost
        target_cost: Target monthly cost
        pattern_data: Workload pattern data (pattern_key, workload_pattern)
        risk_data: Risk assessment data (risk_score, risk_verdict, risk_factors)
        action_steps: Migration action steps
        cross_family: Cross-family recommendations
        reasons: Recommendation reasons
        recommendation: Computed recommendation (overrides ml_prediction mapping if provided)
    
    Returns:
        CloudOptix format response dictionary
    
    Examples:
        >>> format_cloudoptix_response(item, 1, [0.85, 0.10, 0.05], 0.85, ...)
        {'recommendation': 'DOWNSIZE', 'confidence': 85.0, ...}
    """
    # Use provided recommendation if available, otherwise map from ML prediction
    if recommendation is None:
        # Map ML prediction to recommendation
        prediction_map = {
            0: "KEEP",      # Optimal
            1: "DOWNSIZE",  # Oversized
            2: "UPSIZE"     # Undersized
        }
        recommendation = prediction_map.get(ml_prediction, "KEEP")
    
    # Normalize confidence to percentage (0-100)
    if confidence <= 1:
        confidence = confidence * 100
    
    # Create probabilities object
    probabilities = {
        "DOWNSIZE": float(ml_probabilities[1]) if len(ml_probabilities) > 1 else 0.0,
        "KEEP": float(ml_probabilities[0]) if len(ml_probabilities) > 0 else 0.0,
        "UPSIZE": float(ml_probabilities[2]) if len(ml_probabilities) > 2 else 0.0
    }
    
    # Extract target family from target instance
    try:
        target_family = target_instance.split(".")[0]
    except (AttributeError, IndexError):
        target_family = ""
    
    # Calculate resize steps (number of size changes)
    resize_steps = calculate_resize_steps(current_instance, target_instance)
    
    # Calculate savings
    monthly_saving = round(current_cost - target_cost, 2)
    annual_saving = round(monthly_saving * 12, 2)
    
    # Round costs to 2 decimal places
    current_monthly_cost = round(current_cost, 2)
    estimated_new_cost = round(target_cost, 2)
    
    # Generate ISO 8601 timestamp
    generated_at = datetime.utcnow().isoformat() + "Z"
    
    # Assemble CloudOptix response
    return {
        # Core recommendation
        "recommendation": recommendation,
        "confidence": round(confidence, 2),
        "probabilities": probabilities,
        
        # Workload analysis
        "workload_pattern": pattern_data.get("workload_pattern", "⚖️ Balanced Workload"),
        "pattern_key": pattern_data.get("pattern_key", "balanced"),
        
        # Instance details
        "current_instance": current_instance,
        "target_instance": target_instance,
        "target_family": target_family,
        "resize_steps": resize_steps,
        
        # Cost analysis (CloudOptix format)
        "current_monthly_cost": current_monthly_cost,
        "estimated_new_cost": estimated_new_cost,
        "monthly_saving": monthly_saving,
        "annual_saving": annual_saving,
        
        # Cost analysis (Legacy format for frontend compatibility)
        "current_cost_per_month": current_monthly_cost,
        "optimized_cost_per_month": estimated_new_cost,
        "savings": monthly_saving,
        "instance_type": current_instance,
        "recommended_type": target_instance,
        "prediction": recommendation,
        
        # Risk assessment
        "risk_score": risk_data.get("risk_score", 0),
        "risk_verdict": risk_data.get("risk_verdict", "✅ PROCEED"),
        "risk_factors": risk_data.get("risk_factors", []),
        
        # Guidance
        "reasons": reasons,
        "action_steps": action_steps,
        "cross_family_options": cross_family,
        
        # Metadata
        "cloud_provider": item.get("cloud", "aws"),
        "environment": item.get("environment", "production"),
        "os_type": item.get("os_type", "Linux"),
        "region": item.get("region", "us-east-1"),
        "generated_at": generated_at
    }


def calculate_resize_steps(current_instance: str, target_instance: str) -> int:
    """
    Calculate the number of resize steps between two instance types.
    
    Args:
        current_instance: Current instance type (e.g., "m5.xlarge")
        target_instance: Target instance type (e.g., "m5.large")
    
    Returns:
        Number of size steps (1 for adjacent sizes, 2+ for larger jumps)
    
    Examples:
        >>> calculate_resize_steps("m5.xlarge", "m5.large")
        1
        >>> calculate_resize_steps("m5.2xlarge", "m5.large")
        2
    """
    # Size hierarchy for common instance sizes
    size_order = [
        "nano", "micro", "small", "medium", "large", "xlarge",
        "2xlarge", "3xlarge", "4xlarge", "6xlarge", "8xlarge",
        "9xlarge", "10xlarge", "12xlarge", "16xlarge", "18xlarge",
        "24xlarge", "32xlarge", "48xlarge", "56xlarge", "112xlarge"
    ]
    
    try:
        # Extract sizes from instance types
        current_size = current_instance.split(".")[-1]
        target_size = target_instance.split(".")[-1]
        
        # Find positions in size hierarchy
        current_idx = size_order.index(current_size)
        target_idx = size_order.index(target_size)
        
        # Return absolute difference
        return abs(current_idx - target_idx)
    except (ValueError, IndexError, AttributeError):
        # If sizes not found or invalid format, return 1 as default
        return 1
