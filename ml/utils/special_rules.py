"""
Special Business Rules Engine

This module applies business logic overrides to ML predictions.
Handles special cases like database workloads and bursty patterns that require
conservative sizing decisions.
"""

from typing import List, Tuple


def apply_special_rules(
    ml_recommendation: str,
    pattern_key: str,
    cpu_avg: float,
    mem_avg: float,
    cpu_p95: float,
    reasons: List[str]
) -> Tuple[str, List[str]]:
    """
    Apply special business rules that may override ML predictions.
    
    Args:
        ml_recommendation: Original ML recommendation ("DOWNSIZE", "KEEP", "UPSIZE")
        pattern_key: Workload pattern identifier
        cpu_avg: Average CPU utilization (0-100)
        mem_avg: Average memory utilization (0-100)
        cpu_p95: 95th percentile CPU utilization (0-100)
        reasons: List of existing recommendation reasons
    
    Returns:
        Tuple of (final_recommendation, updated_reasons)
    
    Examples:
        >>> apply_special_rules("DOWNSIZE", "database", 20, 70, 25, [])
        ('KEEP', ['Database workload with high memory usage - keeping current size for stability'])
        
        >>> apply_special_rules("DOWNSIZE", "bursty", 25, 40, 85, [])
        ('KEEP', ['Bursty workload needs headroom for traffic spikes - keeping current size'])
    """
    updated_reasons = reasons.copy()
    
    # Rule 1: Database Pattern Override
    # Database workloads with high memory usage should not be downsized
    if pattern_key == "database" and cpu_avg < 25 and mem_avg > 65:
        if ml_recommendation == "DOWNSIZE":
            updated_reasons.append(
                "Database workload with high memory usage - keeping current size for stability"
            )
            return ("KEEP", updated_reasons)
    
    # Rule 2: Bursty Workload Override
    # Bursty workloads need headroom for traffic spikes
    if pattern_key == "bursty" and cpu_avg > 0:
        ratio = cpu_p95 / cpu_avg if cpu_avg > 0 else 0
        if ratio > 3 and cpu_p95 > 60:
            if ml_recommendation == "DOWNSIZE":
                updated_reasons.append(
                    "Bursty workload needs headroom for traffic spikes - keeping current size"
                )
                return ("KEEP", updated_reasons)
    
    # No override - return original recommendation
    return (ml_recommendation, updated_reasons)
