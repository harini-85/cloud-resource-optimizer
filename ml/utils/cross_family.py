"""
Cross-Family Instance Recommender

This module suggests alternative instance families optimized for specific workload patterns.
Provides up to 3 recommendations with reasoning for each suggestion.
"""

from typing import List, Tuple


# Pattern to family mapping with reasons
PATTERN_FAMILY_MAP = {
    "memory_heavy": {
        "families": ["r5", "r6i", "r6a"],
        "reason": "Memory-optimized instances provide better price/performance for memory-intensive workloads"
    },
    "database": {
        "families": ["r5", "r6i", "r6a"],
        "reason": "Database workloads benefit from memory-optimized instances with higher memory-to-CPU ratios"
    },
    "cpu_bound": {
        "families": ["c5", "c6i", "c6a"],
        "reason": "Compute-optimized instances offer better price/performance for CPU-intensive workloads"
    },
    "balanced": {
        "families": ["m5", "m6i", "m6a"],
        "reason": "General-purpose instances provide balanced resources for mixed workloads"
    },
    "zombie": {
        "families": ["t3", "t4g"],
        "reason": "Burstable instances are cost-effective for minimal usage patterns"
    },
    "idle": {
        "families": ["t3", "t4g"],
        "reason": "Burstable instances are cost-effective for low utilization workloads"
    },
    "bursty": {
        "families": [],
        "reason": ""
    },
    "fully_loaded": {
        "families": [],
        "reason": ""
    }
}


def get_cross_family_recommendations(
    pattern_key: str,
    current_instance: str,
    cloud_provider: str
) -> List[List[str]]:
    """
    Get cross-family instance recommendations based on workload pattern.
    
    Args:
        pattern_key: Workload pattern identifier (e.g., "memory_heavy", "cpu_bound")
        current_instance: Current instance type (e.g., "m5.xlarge")
        cloud_provider: Cloud provider name (e.g., "aws", "azure", "gcp")
    
    Returns:
        List of [instance_type, reason] pairs (max 3 recommendations)
        Returns empty list if no better family exists for the pattern
    
    Examples:
        >>> get_cross_family_recommendations("memory_heavy", "m5.xlarge", "aws")
        [['r5.xlarge', 'Memory-optimized instances provide better...'], ...]
        
        >>> get_cross_family_recommendations("bursty", "m5.large", "aws")
        []
    """
    # Get pattern mapping
    if pattern_key not in PATTERN_FAMILY_MAP:
        return []
    
    mapping = PATTERN_FAMILY_MAP[pattern_key]
    families = mapping["families"]
    reason = mapping["reason"]
    
    # Return empty if no recommendations for this pattern
    if not families:
        return []
    
    # Extract current family and size from instance type
    # Format: family.size (e.g., "m5.xlarge" -> family="m5", size="xlarge")
    try:
        current_family, size = current_instance.split(".", 1)
    except ValueError:
        # Invalid instance format, return empty
        return []
    
    # Filter out current family from suggestions
    suggested_families = [f for f in families if f != current_family]
    
    # Limit to 3 recommendations
    suggested_families = suggested_families[:3]
    
    # Build recommendations with equivalent sizes
    recommendations = []
    for family in suggested_families:
        instance_type = f"{family}.{size}"
        recommendations.append([instance_type, reason])
    
    return recommendations
