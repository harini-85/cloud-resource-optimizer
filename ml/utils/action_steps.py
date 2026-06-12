"""
Action Steps Generator

This module creates step-by-step migration instructions for VM sizing changes.
Provides detailed guidance for DOWNSIZE, UPSIZE, and KEEP recommendations.
"""

from typing import List


def generate_action_steps(
    recommendation: str,
    current_instance: str,
    target_instance: str,
    monthly_saving: float,
    cloud_provider: str
) -> List[str]:
    """
    Generate step-by-step action instructions for implementing a sizing recommendation.
    
    Args:
        recommendation: Recommendation type ("DOWNSIZE", "KEEP", "UPSIZE")
        current_instance: Current instance type (e.g., "m5.xlarge")
        target_instance: Target instance type (e.g., "m5.large")
        monthly_saving: Monthly cost savings (negative for cost increase)
        cloud_provider: Cloud provider name (e.g., "aws", "azure", "gcp")
    
    Returns:
        List of human-readable action steps with step numbers
    
    Examples:
        >>> generate_action_steps("DOWNSIZE", "m5.xlarge", "m5.large", 50.0, "aws")
        ['1. Create snapshot/backup of m5.xlarge before making changes', ...]
        
        >>> generate_action_steps("KEEP", "m5.large", "m5.large", 0.0, "aws")
        ['1. No action required - instance is optimally sized', ...]
    """
    if recommendation == "KEEP":
        return [
            "1. No action required - instance is optimally sized",
            "2. Continue monitoring utilization trends",
            "3. Review recommendation again in 30 days"
        ]
    
    if recommendation == "DOWNSIZE":
        return [
            f"1. Create snapshot/backup of {current_instance} before making changes",
            "2. Schedule maintenance window during low-traffic period",
            "3. Stop the instance gracefully",
            f"4. Resize from {current_instance} to {target_instance}",
            "5. Start the instance and verify boot process",
            "6. Monitor CPU and memory for 24-48 hours",
            "7. Validate application performance meets SLAs",
            "8. Keep snapshot for 7 days for rollback if needed",
            f"9. Expected monthly savings: ${monthly_saving:.2f}" if monthly_saving is not None else "9. Expected monthly savings: TBD"
        ]
    
    if recommendation == "UPSIZE":
        cost_increase = abs(monthly_saving) if monthly_saving is not None else 0
        return [
            f"1. Create snapshot/backup of {current_instance} before making changes",
            "2. Schedule maintenance window during low-traffic period",
            "3. Stop the instance gracefully",
            f"4. Resize from {current_instance} to {target_instance}",
            "5. Start the instance and verify boot process",
            "6. Monitor performance improvement",
            "7. Validate application performance meets SLAs",
            f"8. Expected monthly cost increase: ${cost_increase:.2f}" if monthly_saving is not None else "8. Expected monthly cost increase: TBD"
        ]
    
    # Fallback for unknown recommendation types
    return [
        "1. Review recommendation details carefully",
        "2. Consult with your team before making changes"
    ]
