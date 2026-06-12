"""
Risk Scoring Engine

This module calculates risk scores and identifies risk factors for VM sizing recommendations.
Risk scores range from 0-100 with verdicts: PROCEED, REVIEW FIRST, or HOLD.
"""

from typing import Dict, List


def calculate_risk_score(
    recommendation: str,
    cpu_avg: float,
    cpu_p95: float,
    mem_avg: float,
    mem_p95: float,
    confidence: float,
    pattern_key: str
) -> Dict:
    """
    Calculate risk score and identify risk factors for a sizing recommendation.
    
    Args:
        recommendation: Recommendation type ("DOWNSIZE", "KEEP", "UPSIZE")
        cpu_avg: Average CPU utilization (0-100)
        cpu_p95: 95th percentile CPU utilization (0-100)
        mem_avg: Average memory utilization (0-100)
        mem_p95: 95th percentile memory utilization (0-100)
        confidence: Prediction confidence (0-1 or 0-100)
        pattern_key: Workload pattern identifier
    
    Returns:
        Dictionary with:
            - risk_score: Integer 0-100
            - risk_verdict: String verdict with emoji
            - risk_factors: List of risk warning messages
    
    Examples:
        >>> calculate_risk_score("KEEP", 50, 60, 50, 60, 0.85, "balanced")
        {'risk_score': 0, 'risk_verdict': '✅ PROCEED', 'risk_factors': []}
        
        >>> calculate_risk_score("DOWNSIZE", 70, 85, 70, 90, 0.65, "bursty")
        {'risk_score': 75, 'risk_verdict': '🔴 HOLD', 'risk_factors': [...]}
    """
    # Initialize
    risk_score = 0
    risk_factors = []
    
    # KEEP recommendations have zero risk
    if recommendation == "KEEP":
        return {
            "risk_score": 0,
            "risk_verdict": "✅ PROCEED",
            "risk_factors": []
        }
    
    # Normalize confidence to 0-1 range if needed
    if confidence > 1:
        confidence = confidence / 100
    
    # DOWNSIZE risk factors
    if recommendation == "DOWNSIZE":
        # High CPU peaks
        if cpu_p95 > 80:
            risk_score += 20
            risk_factors.append(f"High CPU peaks detected (p95: {cpu_p95:.1f}%)")
        
        # High memory peaks
        if mem_p95 > 85:
            risk_score += 25
            risk_factors.append(f"High memory peaks detected (p95: {mem_p95:.1f}%)")
        
        # Bursty workload
        if pattern_key == "bursty":
            risk_score += 20
            risk_factors.append("Bursty workload may need headroom")
    
    # UPSIZE risk factors
    if recommendation == "UPSIZE":
        # Low utilization
        if cpu_avg < 30 and mem_avg < 30:
            risk_score += 10
            risk_factors.append("Current utilization is low, upsize may be unnecessary")
    
    # Confidence risk (applies to all non-KEEP recommendations)
    if confidence < 0.70:
        risk_score += 15
        confidence_pct = confidence * 100
        risk_factors.append(f"Low prediction confidence ({confidence_pct:.0f}%)")
    
    # Cap risk score at 100
    risk_score = min(risk_score, 100)
    
    # Assign verdict based on score
    if risk_score < 30:
        risk_verdict = "✅ PROCEED"
    elif risk_score <= 70:
        risk_verdict = "⚠️ REVIEW FIRST"
    else:
        risk_verdict = "🔴 HOLD"
    
    return {
        "risk_score": risk_score,
        "risk_verdict": risk_verdict,
        "risk_factors": risk_factors
    }
