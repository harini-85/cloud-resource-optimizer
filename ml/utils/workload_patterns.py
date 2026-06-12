"""
Workload Pattern Detection Module

This module classifies VM workloads based on CPU and memory utilization patterns.
Supports 8 pattern types: zombie, idle, database, bursty, cpu_bound, memory_heavy, 
fully_loaded, and balanced.
"""

from typing import Dict, Optional


def detect_workload_pattern(
    cpu_avg: float,
    cpu_p95: float,
    mem_avg: float,
    mem_p95: float,
    os_type: Optional[str] = None
) -> Dict[str, str]:
    """
    Detect workload pattern based on CPU and memory metrics.
    
    Args:
        cpu_avg: Average CPU utilization (0-100)
        cpu_p95: 95th percentile CPU utilization (0-100)
        mem_avg: Average memory utilization (0-100)
        mem_p95: 95th percentile memory utilization (0-100)
        os_type: Operating system type (optional, used for Windows adjustment)
    
    Returns:
        Dictionary with:
            - pattern_key: Machine-readable pattern identifier
            - workload_pattern: Human-readable pattern with emoji
    
    Examples:
        >>> detect_workload_pattern(3.0, 5.0, 8.0, 10.0)
        {'pattern_key': 'zombie', 'workload_pattern': '🧟 Zombie Instance'}
        
        >>> detect_workload_pattern(20.0, 75.0, 40.0, 50.0)
        {'pattern_key': 'bursty', 'workload_pattern': '⚡ Bursty Workload'}
    """
    # Apply Windows memory adjustment (subtract 18%)
    if os_type and "Windows" in os_type:
        mem_avg = mem_avg * 0.82
        mem_p95 = mem_p95 * 0.82
    
    # Pattern detection in priority order (first match wins)
    
    # 1. Zombie: Very low CPU and memory
    if cpu_avg < 5 and mem_avg < 10:
        return {
            "pattern_key": "zombie",
            "workload_pattern": "🧟 Zombie Instance"
        }
    
    # 2. Idle: Low CPU and memory
    if cpu_avg < 15 and mem_avg < 25:
        return {
            "pattern_key": "idle",
            "workload_pattern": "😴 Idle Instance"
        }
    
    # 3. Database: Low CPU but high memory
    if cpu_avg < 25 and mem_avg > 65:
        return {
            "pattern_key": "database",
            "workload_pattern": "🗄️ Database Workload"
        }
    
    # 4. Bursty: High CPU spikes relative to average
    if cpu_avg > 0 and (cpu_p95 / cpu_avg) > 3 and cpu_p95 > 60:
        return {
            "pattern_key": "bursty",
            "workload_pattern": "⚡ Bursty Workload"
        }
    
    # 5. CPU Bound: High CPU, low memory
    if cpu_avg > 70 and mem_avg < 50:
        return {
            "pattern_key": "cpu_bound",
            "workload_pattern": "🔥 CPU-Bound Workload"
        }
    
    # 6. Memory Heavy: High memory, low CPU
    if mem_avg > 70 and cpu_avg < 50:
        return {
            "pattern_key": "memory_heavy",
            "workload_pattern": "💾 Memory-Heavy Workload"
        }
    
    # 7. Fully Loaded: High CPU and memory
    if cpu_avg > 80 and mem_avg > 80:
        return {
            "pattern_key": "fully_loaded",
            "workload_pattern": "🚀 Fully Loaded"
        }
    
    # 8. Balanced: Default pattern
    return {
        "pattern_key": "balanced",
        "workload_pattern": "⚖️ Balanced Workload"
    }
