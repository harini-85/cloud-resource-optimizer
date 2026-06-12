"""
Feature Engineering Module
Transforms 12 raw features into 59 engineered features for XGBoost model
Matches the features used during model training
"""
import pandas as pd
import numpy as np

# Feature names expected by the model (59 features)
EXPECTED_FEATURES = [
    'cpu_avg', 'cpu_max', 'cpu_p95', 'mem_avg', 'mem_max', 'mem_p95',
    'cpu_headroom', 'cpu_spike_magnitude', 'cpu_avg_to_max_ratio', 'cpu_burst_ratio',
    'cpu_is_idle', 'cpu_is_underused', 'cpu_is_healthy', 'cpu_is_saturated', 'cpu_zone',
    'mem_headroom', 'mem_spike_magnitude', 'mem_avg_to_max_ratio', 'mem_burst_ratio',
    'mem_is_low', 'mem_is_high', 'mem_is_critical', 'mem_zone',
    'mem_avg_win_adj', 'mem_p95_win_adj',
    'low_cpu_high_mem', 'both_maxed', 'both_idle', 'resource_pressure', 'weighted_pressure',
    'cpu_mem_product', 'is_borderline', 'is_bursty',
    'disk_utilization_percent', 'disk_io_total', 'disk_io_log', 'disk_is_heavy', 'disk_io_per_gb',
    'network_total_mbps', 'network_log', 'network_is_heavy',
    'monthly_cost_usd', 'running_hours', 'observation_days', 'cost_per_hour', 'instance_age_days',
    'old_and_idle', 'obs_quality',
    'cloud_provider_enc', 'os_type_enc', 'environment_enc', 'reservation_type_enc', 'pricing_model_enc',
    'is_memory_inst', 'is_compute_inst', 'is_burstable', 'is_gpu_inst', 'is_storage_inst', 'is_windows'
]


def engineer_features(raw_data: dict) -> dict:
    """
    Transform 12 raw features into 59 engineered features
    
    Args:
        raw_data: Dictionary with 12 raw features:
            - cpu_avg, cpu_p95
            - memory_avg, memory_p95
            - disk_read_iops, disk_write_iops
            - network_in_bytes, network_out_bytes
            - vcpu_count, ram_gb
            - uptime_hours, cost_per_month
            - cloud, region, instance_type (metadata)
    
    Returns:
        Dictionary with 59 engineered features
    """
    # Extract raw features with defaults
    cpu_avg = raw_data.get('cpu_avg', 0)
    cpu_p95 = raw_data.get('cpu_p95', 0)
    memory_avg = raw_data.get('memory_avg', 0)
    memory_p95 = raw_data.get('memory_p95', 0)
    disk_read_iops = raw_data.get('disk_read_iops', 0)
    disk_write_iops = raw_data.get('disk_write_iops', 0)
    network_in_bytes = raw_data.get('network_in_bytes', 0)
    network_out_bytes = raw_data.get('network_out_bytes', 0)
    vcpu_count = raw_data.get('vcpu_count', 2)
    ram_gb = raw_data.get('ram_gb', 4)
    uptime_hours = raw_data.get('uptime_hours', 720)
    cost_per_month = raw_data.get('cost_per_month', 0)
    
    # Metadata
    cloud = raw_data.get('cloud', 'aws').lower()
    instance_type = raw_data.get('instance_type', '').lower()
    os_type = raw_data.get('os', 'linux').lower()
    
    # === CPU Features ===
    cpu_max = cpu_p95  # Use p95 as max
    cpu_headroom = max(0, 100 - cpu_p95)
    cpu_spike_magnitude = max(0, cpu_p95 - cpu_avg)
    cpu_avg_to_max_ratio = cpu_avg / cpu_max if cpu_max > 0 else 0
    cpu_burst_ratio = cpu_p95 / cpu_avg if cpu_avg > 0 else 1.0
    
    # CPU zones
    cpu_is_idle = 1 if cpu_avg < 5 else 0
    cpu_is_underused = 1 if 5 <= cpu_avg < 30 else 0
    cpu_is_healthy = 1 if 30 <= cpu_avg < 70 else 0
    cpu_is_saturated = 1 if cpu_avg >= 70 else 0
    
    # CPU zone encoding (0=idle, 1=underused, 2=healthy, 3=saturated)
    if cpu_avg < 5:
        cpu_zone = 0
    elif cpu_avg < 30:
        cpu_zone = 1
    elif cpu_avg < 70:
        cpu_zone = 2
    else:
        cpu_zone = 3
    
    # === Memory Features ===
    mem_avg = memory_avg
    mem_max = memory_p95
    mem_p95 = memory_p95
    mem_headroom = max(0, 100 - memory_p95)
    mem_spike_magnitude = max(0, memory_p95 - memory_avg)
    mem_avg_to_max_ratio = memory_avg / memory_p95 if memory_p95 > 0 else 0
    mem_burst_ratio = memory_p95 / memory_avg if memory_avg > 0 else 1.0
    
    # Memory zones
    mem_is_low = 1 if memory_avg < 30 else 0
    mem_is_high = 1 if 30 <= memory_avg < 70 else 0
    mem_is_critical = 1 if memory_avg >= 70 else 0
    
    # Memory zone encoding (0=low, 1=high, 2=critical)
    if memory_avg < 30:
        mem_zone = 0
    elif memory_avg < 70:
        mem_zone = 1
    else:
        mem_zone = 2
    
    # Memory adjustments (no adjustment needed for now)
    mem_avg_win_adj = memory_avg
    mem_p95_win_adj = memory_p95
    
    # === Combined Resource Features ===
    low_cpu_high_mem = 1 if cpu_avg < 30 and memory_avg > 70 else 0
    both_maxed = 1 if cpu_avg > 80 and memory_avg > 80 else 0
    both_idle = 1 if cpu_avg < 10 and memory_avg < 10 else 0
    
    # Resource pressure (0-200 scale)
    resource_pressure = cpu_avg + memory_avg
    weighted_pressure = (cpu_avg * 0.6) + (memory_avg * 0.4)
    cpu_mem_product = (cpu_avg / 100) * (memory_avg / 100) * 100
    
    # Borderline and bursty detection
    is_borderline = 1 if (60 <= cpu_avg <= 80) or (60 <= memory_avg <= 80) else 0
    is_bursty = 1 if cpu_burst_ratio > 1.5 or mem_burst_ratio > 1.5 else 0
    
    # === Disk Features ===
    disk_io_total = disk_read_iops + disk_write_iops
    disk_utilization_percent = min(100, (disk_io_total / 1000) * 100) if disk_io_total > 0 else 0
    disk_io_log = np.log1p(disk_io_total)
    disk_is_heavy = 1 if disk_io_total > 500 else 0
    disk_io_per_gb = disk_io_total / ram_gb if ram_gb > 0 else 0
    
    # === Network Features ===
    network_total_bytes = network_in_bytes + network_out_bytes
    network_total_mbps = (network_total_bytes / 1_000_000) / (uptime_hours / 24) if uptime_hours > 0 else 0
    network_log = np.log1p(network_total_bytes)
    network_is_heavy = 1 if network_total_mbps > 100 else 0
    
    # === Cost and Time Features ===
    monthly_cost_usd = cost_per_month
    running_hours = uptime_hours
    observation_days = uptime_hours / 24
    cost_per_hour = cost_per_month / 730 if cost_per_month > 0 else 0
    instance_age_days = uptime_hours / 24
    old_and_idle = 1 if instance_age_days > 30 and cpu_avg < 5 else 0
    
    # Observation quality (0=poor, 1=fair, 2=good, 3=excellent)
    if observation_days < 7:
        obs_quality = 0
    elif observation_days < 14:
        obs_quality = 1
    elif observation_days < 30:
        obs_quality = 2
    else:
        obs_quality = 3
    
    # === Categorical Encodings ===
    # Cloud provider encoding (0=aws, 1=azure, 2=gcp)
    cloud_provider_enc = {'aws': 0, 'azure': 1, 'gcp': 2}.get(cloud, 0)
    
    # OS type encoding (0=linux, 1=windows)
    os_type_enc = 1 if 'windows' in os_type else 0
    
    # Environment encoding (0=production, 1=dev, 2=test) - default to production
    environment_enc = 0
    
    # Reservation type encoding (0=on-demand, 1=reserved, 2=spot) - default to on-demand
    reservation_type_enc = 0
    
    # Pricing model encoding (0=on-demand, 1=reserved, 2=spot) - default to on-demand
    pricing_model_enc = 0
    
    # === Instance Type Features ===
    # Detect instance family from instance_type
    is_memory_inst = 1 if any(x in instance_type for x in ['r5', 'r6', 'x1', 'x2', 'z1']) else 0
    is_compute_inst = 1 if any(x in instance_type for x in ['c5', 'c6', 'c7']) else 0
    is_burstable = 1 if any(x in instance_type for x in ['t2', 't3', 't4']) else 0
    is_gpu_inst = 1 if any(x in instance_type for x in ['p2', 'p3', 'p4', 'g4', 'g5']) else 0
    is_storage_inst = 1 if any(x in instance_type for x in ['d2', 'd3', 'i3', 'i4']) else 0
    is_windows = os_type_enc
    
    # Build feature dictionary in exact order expected by model
    features = {
        'cpu_avg': cpu_avg,
        'cpu_max': cpu_max,
        'cpu_p95': cpu_p95,
        'mem_avg': mem_avg,
        'mem_max': mem_max,
        'mem_p95': mem_p95,
        'cpu_headroom': cpu_headroom,
        'cpu_spike_magnitude': cpu_spike_magnitude,
        'cpu_avg_to_max_ratio': cpu_avg_to_max_ratio,
        'cpu_burst_ratio': cpu_burst_ratio,
        'cpu_is_idle': cpu_is_idle,
        'cpu_is_underused': cpu_is_underused,
        'cpu_is_healthy': cpu_is_healthy,
        'cpu_is_saturated': cpu_is_saturated,
        'cpu_zone': cpu_zone,
        'mem_headroom': mem_headroom,
        'mem_spike_magnitude': mem_spike_magnitude,
        'mem_avg_to_max_ratio': mem_avg_to_max_ratio,
        'mem_burst_ratio': mem_burst_ratio,
        'mem_is_low': mem_is_low,
        'mem_is_high': mem_is_high,
        'mem_is_critical': mem_is_critical,
        'mem_zone': mem_zone,
        'mem_avg_win_adj': mem_avg_win_adj,
        'mem_p95_win_adj': mem_p95_win_adj,
        'low_cpu_high_mem': low_cpu_high_mem,
        'both_maxed': both_maxed,
        'both_idle': both_idle,
        'resource_pressure': resource_pressure,
        'weighted_pressure': weighted_pressure,
        'cpu_mem_product': cpu_mem_product,
        'is_borderline': is_borderline,
        'is_bursty': is_bursty,
        'disk_utilization_percent': disk_utilization_percent,
        'disk_io_total': disk_io_total,
        'disk_io_log': disk_io_log,
        'disk_is_heavy': disk_is_heavy,
        'disk_io_per_gb': disk_io_per_gb,
        'network_total_mbps': network_total_mbps,
        'network_log': network_log,
        'network_is_heavy': network_is_heavy,
        'monthly_cost_usd': monthly_cost_usd,
        'running_hours': running_hours,
        'observation_days': observation_days,
        'cost_per_hour': cost_per_hour,
        'instance_age_days': instance_age_days,
        'old_and_idle': old_and_idle,
        'obs_quality': obs_quality,
        'cloud_provider_enc': cloud_provider_enc,
        'os_type_enc': os_type_enc,
        'environment_enc': environment_enc,
        'reservation_type_enc': reservation_type_enc,
        'pricing_model_enc': pricing_model_enc,
        'is_memory_inst': is_memory_inst,
        'is_compute_inst': is_compute_inst,
        'is_burstable': is_burstable,
        'is_gpu_inst': is_gpu_inst,
        'is_storage_inst': is_storage_inst,
        'is_windows': is_windows
    }
    
    return features


def engineer_features_batch(raw_data_list: list) -> pd.DataFrame:
    """
    Transform batch of raw data into engineered features DataFrame
    
    Args:
        raw_data_list: List of dictionaries with raw features
    
    Returns:
        DataFrame with 59 engineered features, rows in same order as input
    """
    engineered_list = [engineer_features(raw_data) for raw_data in raw_data_list]
    df = pd.DataFrame(engineered_list)
    
    # Ensure columns are in the exact order expected by the model
    df = df[EXPECTED_FEATURES]
    
    return df