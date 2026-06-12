const logger = require('../utils/logger');

/**
 * Normalization Service
 * Converts ANY input (file upload or cloud API data) into a unified schema
 */

class NormalizationError extends Error {
    constructor(message, field) {
        super(message);
        this.name = 'NormalizationError';
        this.field = field;
    }
}

/**
 * Column mapping variations for CSV files
 */
const COLUMN_MAPPINGS = {
    // Instance identification
    instance_id: ['instance_id', 'instanceid', 'instance-id', 'id', 'vm_id', 'vmid', 'resource_id', 'resourceid'],
    instance_type: ['instance_type', 'instancetype', 'instance-type', 'type', 'vm_size', 'vmsize', 'size', 'machine_type'],

    // Location
    region: ['region', 'location', 'zone', 'availability_zone', 'az'],
    cloud: ['cloud', 'provider', 'cloud_provider'],
    account_id: ['account_id', 'accountid', 'account', 'subscription_id', 'project_id'],

    // OS
    os: ['os', 'operating_system', 'platform', 'os_type'],

    // Timestamp - Enhanced with more variations
    timestamp: [
        'timestamp', 'date', 'datetime', 'time', 'created_at', 'created_date', 'creation_time',
        'start_time', 'end_time', 'last_seen', 'first_seen', 'observation_date', 'sample_date',
        'metric_date', 'data_date', 'collection_date', 'report_date', 'event_time', 'event_date',
        'period_start', 'period_end', 'measurement_time', 'recorded_at', 'captured_at',
        'year', 'month', 'day', 'week', 'quarter', 'period'
    ],

    // CPU metrics
    cpu_avg: ['cpu_avg', 'avg_cpu', 'cpu_average', 'average_cpu', 'cpu%', 'cpu_util', 'cpu_utilization', 'cpuavg', 'cpuutil'],
    cpu_p95: ['cpu_p95', 'p95_cpu', 'cpu_95', '95_cpu', 'cpu_p95_util', 'p95cpu'],

    // Memory metrics
    memory_avg: ['memory_avg', 'avg_memory', 'mem_avg', 'avg_mem', 'memory%', 'mem%', 'memory_util', 'memory_utilization', 'memavg', 'memutil'],
    memory_p95: ['memory_p95', 'p95_memory', 'mem_p95', 'p95_mem', 'memory_95', 'p95memory'],

    // Disk metrics
    disk_read_iops: ['disk_read_iops', 'read_iops', 'disk_read', 'iops_read', 'diskreadiops'],
    disk_write_iops: ['disk_write_iops', 'write_iops', 'disk_write', 'iops_write', 'diskwriteiops'],

    // Network metrics
    network_in_bytes: ['network_in_bytes', 'network_in', 'net_in', 'bytes_in', 'networkin'],
    network_out_bytes: ['network_out_bytes', 'network_out', 'net_out', 'bytes_out', 'networkout'],

    // Instance specs
    vcpu_count: ['vcpu_count', 'vcpu', 'vcpus', 'cpu_count', 'cpus', 'cores', 'cpu'],
    ram_gb: ['ram_gb', 'ram', 'memory_gb', 'memory', 'mem_gb', 'memgb'],

    // Usage
    uptime_hours: ['uptime_hours', 'uptime', 'hours', 'runtime_hours', 'runtime'],

    // Cost
    cost_per_month: ['cost_per_month', 'monthly_cost', 'cost', 'price', 'monthly_price', 'cost_month'],

    // New 12 features for enhanced ML model
    cpu_spike_ratio: ['cpu_spike_ratio', 'cpuspikeratio', 'cpu_spike', 'spike_ratio_cpu'],
    memory_spike_ratio: ['memory_spike_ratio', 'memoryspikeratio', 'memory_spike', 'spike_ratio_memory'],
    cpu_throttle_percent: ['cpu_throttle_percent', 'cputhrottlepercent', 'cpu_throttle', 'throttle_percent'],
    peak_hour_avg_cpu: ['peak_hour_avg_cpu', 'peakhouravgcpu', 'peak_cpu', 'peak_hour_cpu'],
    off_peak_avg_cpu: ['off_peak_avg_cpu', 'offpeakavgcpu', 'offpeak_cpu', 'off_peak_cpu'],
    weekend_avg_cpu: ['weekend_avg_cpu', 'weekendavgcpu', 'weekend_cpu'],
    memory_swap_usage: ['memory_swap_usage', 'memoryswapusage', 'swap_usage', 'swap'],
    disk_latency_ms: ['disk_latency_ms', 'disklatencyms', 'disk_latency', 'latency_ms'],
    network_packet_loss: ['network_packet_loss', 'networkpacketloss', 'packet_loss', 'packetloss'],
    data_days: ['data_days', 'datadays', 'days', 'coverage_days'],
    granularity_hourly: ['granularity_hourly', 'granularityhourly', 'hourly', 'granularity'],
    workload_pattern: ['workload_pattern', 'workloadpattern', 'pattern', 'workload']
};

/**
 * Detect cloud provider from column names or data
 */
function detectCloudType(data, columns = []) {
    const dataStr = JSON.stringify(data).toLowerCase();
    const columnsStr = columns.join(',').toLowerCase();
    const combined = dataStr + columnsStr;

    if (combined.includes('i-') || combined.includes('aws') || combined.includes('ec2')) {
        return 'aws';
    }
    if (combined.includes('azure') || combined.includes('microsoft')) {
        return 'azure';
    }
    if (combined.includes('gcp') || combined.includes('google') || combined.includes('gce')) {
        return 'gcp';
    }

    // Default to AWS if can't detect
    return 'aws';
}

/**
 * Infer OS type from instance type and cloud provider
 * Critical for accurate pricing lookups
 */
function inferOSFromInstanceType(instanceType, cloud) {
    if (!instanceType) return 'Linux';

    const type = instanceType.toLowerCase();
    cloud = cloud.toLowerCase();

    // Windows indicators in instance type names
    const windowsIndicators = [
        'windows', 'win', 'w2016', 'w2019', 'w2022',
        'sqlserver', 'sql', 'iis', 'dotnet', '.net'
    ];

    // Check for Windows indicators
    for (const indicator of windowsIndicators) {
        if (type.includes(indicator)) {
            return 'Windows';
        }
    }

    // Cloud-specific patterns
    if (cloud === 'azure') {
        // Azure Windows VMs sometimes have specific patterns
        // Standard_D8s_v5 (Linux) vs Standard_D8s_v5_Windows (Windows)
        if (type.includes('_windows') || type.endsWith('_w')) {
            return 'Windows';
        }

        // Azure SQL Server VMs
        if (type.includes('sql')) {
            return 'Windows';
        }
    }

    if (cloud === 'aws') {
        // AWS Windows instances often use specific families
        // But most are Linux by default unless explicitly Windows
        if (type.includes('windows') || type.includes('win')) {
            return 'Windows';
        }
    }

    if (cloud === 'gcp') {
        // GCP Windows instances have specific naming
        if (type.includes('windows') || type.includes('win')) {
            return 'Windows';
        }
    }

    // Default to Linux (most common)
    return 'Linux';
}

/**
 * Normalize region names for consistent database lookups
 */
function normalizeRegionName(region, cloud) {
    if (!region) return region;

    const normalized = region.toLowerCase().trim();
    cloud = cloud.toLowerCase();

    // Common region name mappings
    const regionMappings = {
        'aws': {
            'us-east-1': 'us-east-1',
            'us-east-2': 'us-east-2',
            'us-west-1': 'us-west-1',
            'us-west-2': 'us-west-2',
            'eu-west-1': 'eu-west-1',
            'eu-central-1': 'eu-central-1',
            'ap-southeast-1': 'ap-southeast-1',
            'ap-northeast-1': 'ap-northeast-1'
        },
        'azure': {
            'eastus': 'eastus',
            'eastus2': 'eastus2',
            'westus': 'westus',
            'westus2': 'westus2',
            'westus3': 'westus3',
            'centralus': 'centralus',
            'northcentralus': 'northcentralus',
            'southcentralus': 'southcentralus',
            'westcentralus': 'westcentralus',
            'eastus2euap': 'eastus2euap',
            'westeurope': 'westeurope',
            'northeurope': 'northeurope',
            'uksouth': 'uksouth',
            'ukwest': 'ukwest',
            'francecentral': 'francecentral',
            'germanywestcentral': 'germanywestcentral',
            'norwayeast': 'norwayeast',
            'switzerlandnorth': 'switzerlandnorth',
            'uaenorth': 'uaenorth',
            'brazilsouth': 'brazilsouth',
            'southafricanorth': 'southafricanorth',
            'australiaeast': 'australiaeast',
            'australiasoutheast': 'australiasoutheast',
            'eastasia': 'eastasia',
            'southeastasia': 'southeastasia',
            'japaneast': 'japaneast',
            'japanwest': 'japanwest',
            'koreacentral': 'koreacentral',
            'koreasouth': 'koreasouth',
            'southindia': 'southindia',
            'westindia': 'westindia',
            'centralindia': 'centralindia',
            'canadacentral': 'canadacentral',
            'canadaeast': 'canadaeast'
        },
        'gcp': {
            'us-central1': 'us-central1',
            'us-east1': 'us-east1',
            'us-east4': 'us-east4',
            'us-west1': 'us-west1',
            'us-west2': 'us-west2',
            'us-west3': 'us-west3',
            'us-west4': 'us-west4',
            'europe-west1': 'europe-west1',
            'europe-west2': 'europe-west2',
            'europe-west3': 'europe-west3',
            'europe-west4': 'europe-west4',
            'europe-west6': 'europe-west6',
            'asia-east1': 'asia-east1',
            'asia-northeast1': 'asia-northeast1',
            'asia-southeast1': 'asia-southeast1'
        }
    };

    const cloudMappings = regionMappings[cloud];
    if (cloudMappings && cloudMappings[normalized]) {
        return cloudMappings[normalized];
    }

    // Return original if no mapping found
    return region;
}

/**
 * Map column name to standard field name
 */
function mapColumnName(columnName) {
    const normalized = columnName.toLowerCase().trim().replace(/[_\s-]+/g, '_');

    for (const [standardName, variations] of Object.entries(COLUMN_MAPPINGS)) {
        if (variations.includes(normalized)) {
            return standardName;
        }
    }

    return null;
}

/**
 * Auto-detect column mappings from CSV headers
 */
function autoDetectColumns(headers) {
    const mappings = {};
    const unmapped = [];

    for (const header of headers) {
        const standardName = mapColumnName(header);
        if (standardName) {
            mappings[header] = standardName;
        } else {
            unmapped.push(header);
        }
    }

    // Log unmapped columns as info (not error) - they will be ignored
    if (unmapped.length > 0) {
        logger.info(`Ignored unknown columns: [${unmapped.join(', ')}]`);
    }

    return { mappings, unmapped };
}

/**
 * Parse and validate a numeric value
 */
function parseNumber(value, fieldName, min = null, max = null) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const num = typeof value === 'number' ? value : parseFloat(value);

    if (isNaN(num)) {
        throw new NormalizationError(
            `Invalid number for ${fieldName}: "${value}"`,
            fieldName
        );
    }

    if (min !== null && num < min) {
        throw new NormalizationError(
            `${fieldName} must be >= ${min}, got ${num}`,
            fieldName
        );
    }

    if (max !== null && num > max) {
        throw new NormalizationError(
            `${fieldName} must be <= ${max}, got ${num}`,
            fieldName
        );
    }

    return num;
}

/**
 * Parse and validate a string value
 */
function parseString(value, fieldName, required = false) {
    if (value === null || value === undefined || value === '') {
        if (required) {
            throw new NormalizationError(
                `${fieldName} is required but was empty`,
                fieldName
            );
        }
        return null;
    }

    return String(value).trim();
}

/**
 * Enhanced timestamp parsing and validation
 * Supports various date formats and can infer data coverage periods
 */
function parseAndValidateTimestamp(timestampStr) {
    if (!timestampStr || timestampStr.trim() === '') {
        return { isValid: false, reason: 'Empty timestamp' };
    }

    const str = timestampStr.trim().toLowerCase();

    // Try to parse as standard date formats first
    const standardDate = Date.parse(timestampStr);
    if (!isNaN(standardDate)) {
        return {
            isValid: true,
            parsedDate: new Date(standardDate).toISOString(),
            dataRange: null
        };
    }

    // Try to parse as Unix timestamp (seconds or milliseconds)
    const numericValue = Number(timestampStr);
    if (!isNaN(numericValue)) {
        let date;
        // Check if it's seconds (10 digits) or milliseconds (13 digits)
        if (numericValue.toString().length === 10) {
            date = new Date(numericValue * 1000);
        } else if (numericValue.toString().length === 13) {
            date = new Date(numericValue);
        } else {
            return { isValid: false, reason: 'Invalid Unix timestamp length' };
        }

        if (!isNaN(date.getTime())) {
            return {
                isValid: true,
                parsedDate: date.toISOString(),
                dataRange: null
            };
        }
    }

    // Try to parse relative time periods (e.g., "7 days", "2 weeks", "1 month")
    const relativePatterns = [
        { pattern: /(\d+)\s*days?/i, multiplier: 1 },
        { pattern: /(\d+)\s*weeks?/i, multiplier: 7 },
        { pattern: /(\d+)\s*months?/i, multiplier: 30 },
        { pattern: /(\d+)\s*quarters?/i, multiplier: 90 },
        { pattern: /(\d+)\s*years?/i, multiplier: 365 }
    ];

    for (const { pattern, multiplier } of relativePatterns) {
        const match = str.match(pattern);
        if (match) {
            const value = parseInt(match[1]);
            const days = value * multiplier;

            // Create a timestamp representing the end of the period (now)
            const endDate = new Date();

            return {
                isValid: true,
                parsedDate: endDate.toISOString(),
                dataRange: days
            };
        }
    }

    // Try to parse period indicators (e.g., "last_7_days", "past_month", "recent")
    const periodPatterns = [
        { pattern: /last[_\s]*(\d+)[_\s]*days?/i, multiplier: 1 },
        { pattern: /past[_\s]*(\d+)[_\s]*days?/i, multiplier: 1 },
        { pattern: /(\d+)[_\s]*day[_\s]*period/i, multiplier: 1 },
        { pattern: /last[_\s]*week/i, days: 7 },
        { pattern: /past[_\s]*week/i, days: 7 },
        { pattern: /last[_\s]*month/i, days: 30 },
        { pattern: /past[_\s]*month/i, days: 30 },
        { pattern: /last[_\s]*quarter/i, days: 90 },
        { pattern: /recent/i, days: 14 }
    ];

    for (const { pattern, multiplier, days } of periodPatterns) {
        const match = str.match(pattern);
        if (match) {
            let calculatedDays;
            if (multiplier && match[1]) {
                calculatedDays = parseInt(match[1]) * multiplier;
            } else {
                calculatedDays = days;
            }

            const endDate = new Date();

            return {
                isValid: true,
                parsedDate: endDate.toISOString(),
                dataRange: calculatedDays
            };
        }
    }

    // Try common date formats with different separators
    const dateFormats = [
        /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/,  // YYYY/MM/DD, YYYY-MM-DD, YYYY.MM.DD
        /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/,  // MM/DD/YYYY, DD/MM/YYYY
        /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/   // MM/DD/YY, DD/MM/YY
    ];

    for (const format of dateFormats) {
        const match = timestampStr.match(format);
        if (match) {
            try {
                let year, month, day;

                if (format === dateFormats[0]) { // YYYY/MM/DD format
                    year = parseInt(match[1]);
                    month = parseInt(match[2]) - 1; // JavaScript months are 0-indexed
                    day = parseInt(match[3]);
                } else if (format === dateFormats[2] && match[3].length === 2) { // YY format
                    const shortYear = parseInt(match[3]);
                    year = shortYear > 50 ? 1900 + shortYear : 2000 + shortYear;
                    month = parseInt(match[1]) - 1;
                    day = parseInt(match[2]);
                } else { // MM/DD/YYYY or DD/MM/YYYY - assume MM/DD for US format
                    year = parseInt(match[3]);
                    month = parseInt(match[1]) - 1;
                    day = parseInt(match[2]);
                }

                const date = new Date(year, month, day);
                if (!isNaN(date.getTime()) && date.getFullYear() === year) {
                    return {
                        isValid: true,
                        parsedDate: date.toISOString(),
                        dataRange: null
                    };
                }
            } catch (e) {
                // Continue to next format
            }
        }
    }

    return {
        isValid: false,
        reason: `Unrecognized date format: "${timestampStr}". Supported formats: YYYY-MM-DD, MM/DD/YYYY, Unix timestamp, relative periods (e.g., "7 days", "last month")`
    };
}

/**
 * Normalize VM data from file source
 */
function normalizeFromFile(rawData, userMappings = {}, timestampRange = null) {
    const data = {};

    // Define calculated columns that should NOT be accepted from user input
    const CALCULATED_COLUMNS = [
        'cpu_spike_ratio',
        'memory_spike_ratio',
        'peak_hour_avg_cpu',
        'off_peak_avg_cpu',
        'weekend_avg_cpu',
        'workload_pattern'
    ];

    // Apply user mappings if provided
    if (Object.keys(userMappings).length > 0) {
        for (const [originalCol, standardCol] of Object.entries(userMappings)) {
            if (rawData[originalCol] !== undefined) {
                data[standardCol] = rawData[originalCol];
            }
        }
    } else {
        // Auto-detect mappings
        for (const [key, value] of Object.entries(rawData)) {
            const standardName = mapColumnName(key);
            if (standardName) {
                data[standardName] = value;
            }
        }
    }

    // Check if any calculated columns are present in input
    const detectedCalculatedColumns = CALCULATED_COLUMNS.filter(col =>
        data[col] !== null && data[col] !== undefined && data[col] !== ''
    );

    const calculated_columns_detected = detectedCalculatedColumns.length > 0;

    if (calculated_columns_detected) {
        logger.warn(`Calculated columns detected in input — system values used instead: [${detectedCalculatedColumns.join(', ')}]`);

        // Set calculated columns to null (will be calculated later)
        for (const col of CALCULATED_COLUMNS) {
            data[col] = null;
        }
    }

    // Check for timestamp column with enhanced detection
    let hasTimestamp = data.timestamp !== null && data.timestamp !== undefined && data.timestamp !== '';
    let timestampValue = null;
    let detectedDateRange = null;

    // If timestamp exists, validate and process it
    if (hasTimestamp) {
        const timestampStr = String(data.timestamp).trim();

        // Enhanced timestamp validation and parsing
        const timestampResult = parseAndValidateTimestamp(timestampStr);

        if (timestampResult.isValid) {
            timestampValue = timestampResult.parsedDate;
            hasTimestamp = true;

            // Try to detect data range from timestamp if it's a relative format
            if (timestampResult.dataRange) {
                detectedDateRange = timestampResult.dataRange;
                logger.info(`Detected data range from timestamp: ${detectedDateRange} days`);
            }
        } else {
            hasTimestamp = false;
            logger.info(`Malformed timestamp value detected: "${timestampStr}" - treating as missing. Reason: ${timestampResult.reason}`);
        }
    }

    const missing_timestamp = !hasTimestamp;

    // Required fields
    const instance_id = parseString(data.instance_id, 'instance_id', true);
    const instance_type = parseString(data.instance_type, 'instance_type', true);
    const region = parseString(data.region, 'region', true);

    // Check if instance_type exists - this will trigger catalog lookup in enrichment
    const has_instance_type = instance_type !== null && instance_type !== undefined && instance_type !== '';

    // Detect cloud if not provided
    const cloud = parseString(data.cloud, 'cloud') || detectCloudType(rawData);

    // Normalize region name for consistent database lookups
    const normalizedRegion = normalizeRegionName(region, cloud);

    // Optional fields with defaults
    const account_id = parseString(data.account_id, 'account_id') || 'unknown';

    // OS detection - prioritize user input, then infer from instance type
    let os = parseString(data.os, 'os');
    let os_source = 'user_provided';

    if (!os || os === 'unknown') {
        os = inferOSFromInstanceType(instance_type, cloud);
        os_source = 'inferred';
        logger.info(`OS inferred from instance type: ${instance_type} → ${os}`, {
            instance_id,
            instance_type,
            cloud,
            inferred_os: os
        });
    }

    // Original 12 ML features - with validation
    const cpu_avg = parseNumber(data.cpu_avg, 'cpu_avg', 0, 100) || 0;
    const cpu_p95 = parseNumber(data.cpu_p95, 'cpu_p95', 0, 100) || cpu_avg;
    const memory_avg = parseNumber(data.memory_avg, 'memory_avg', 0, 100) || 0;
    const memory_p95 = parseNumber(data.memory_p95, 'memory_p95', 0, 100) || memory_avg;

    const disk_read_iops = parseNumber(data.disk_read_iops, 'disk_read_iops', 0) || 0;
    const disk_write_iops = parseNumber(data.disk_write_iops, 'disk_write_iops', 0) || 0;
    const network_in_bytes = parseNumber(data.network_in_bytes, 'network_in_bytes', 0) || 0;
    const network_out_bytes = parseNumber(data.network_out_bytes, 'network_out_bytes', 0) || 0;

    // Instance specs - prioritize catalog lookup over CSV values
    // If instance_type exists, set flag for enrichment service to query catalog
    // Store CSV values separately as fallback if catalog lookup fails
    let vcpu_count, ram_gb, csv_vcpu_count, csv_ram_gb;
    if (has_instance_type) {
        // Store CSV values as fallback (if provided)
        csv_vcpu_count = parseNumber(data.vcpu_count, 'vcpu_count', 0) || null;
        csv_ram_gb = parseNumber(data.ram_gb, 'ram_gb', 0) || null;

        // Set to null - enrichment service will fetch from catalog first
        vcpu_count = null;
        ram_gb = null;
    } else {
        // No instance_type - use CSV values or defaults
        vcpu_count = parseNumber(data.vcpu_count, 'vcpu_count', 0) || 2;
        ram_gb = parseNumber(data.ram_gb, 'ram_gb', 0) || 4;
        csv_vcpu_count = null;
        csv_ram_gb = null;
    }

    const uptime_hours = parseNumber(data.uptime_hours, 'uptime_hours', 0) || 720;
    const cost_per_month = parseNumber(data.cost_per_month, 'cost_per_month', 0) || 0;

    // New 12 features for enhanced ML model (optional with defaults)
    // Note: Calculated columns are set to null if user-provided (will be calculated later)
    const cpu_spike_ratio = data.cpu_spike_ratio === null ? null : (parseNumber(data.cpu_spike_ratio, 'cpu_spike_ratio', 1.0) ?? 1.0);
    const memory_spike_ratio = data.memory_spike_ratio === null ? null : (parseNumber(data.memory_spike_ratio, 'memory_spike_ratio', 1.0) ?? 1.0);
    const cpu_throttle_percent = parseNumber(data.cpu_throttle_percent, 'cpu_throttle_percent', 0, 100) ?? 0.0;
    const peak_hour_avg_cpu = data.peak_hour_avg_cpu === null ? null : (parseNumber(data.peak_hour_avg_cpu, 'peak_hour_avg_cpu', 0, 100) ?? cpu_avg);
    const off_peak_avg_cpu = data.off_peak_avg_cpu === null ? null : (parseNumber(data.off_peak_avg_cpu, 'off_peak_avg_cpu', 0, 100) ?? cpu_avg);
    const weekend_avg_cpu = data.weekend_avg_cpu === null ? null : (parseNumber(data.weekend_avg_cpu, 'weekend_avg_cpu', 0, 100) ?? cpu_avg);
    const memory_swap_usage = parseNumber(data.memory_swap_usage, 'memory_swap_usage', 0, 100) ?? 0.0;
    const disk_latency_ms = parseNumber(data.disk_latency_ms, 'disk_latency_ms', 0) ?? 10.0;
    const network_packet_loss = parseNumber(data.network_packet_loss, 'network_packet_loss', 0, 100) ?? 0.0;

    // Temporal metrics - handle missing timestamp with enhanced logic
    let data_days, granularity_hourly, workload_pattern, date_source, timestamp_status, confidence_cap, timestamp;

    if (missing_timestamp) {
        // Check if we have timestamp range from CSV analysis
        if (timestampRange && timestampRange.hasTimestamp && timestampRange.dataDays) {
            // Use calculated range from CSV timestamps
            data_days = timestampRange.dataDays;
            granularity_hourly = 1;
            workload_pattern = 0;
            date_source = 'timestamp_calculated';
            timestamp_status = 'calculated_from_range';
            confidence_cap = null; // No cap when we have actual timestamp data
            timestamp = timestampRange.maxDate; // Use most recent timestamp

            logger.info(`[Normalization] Using calculated timestamp range: ${data_days} days (${timestampRange.dataHours} hours)`);
        } else {
            // Set defaults when timestamp is missing
            data_days = parseNumber(data.data_days, 'data_days', 1) ?? 30;
            granularity_hourly = 1;
            workload_pattern = 0;
            date_source = 'user_provided';
            timestamp_status = 'missing';
            confidence_cap = 0.70;
            timestamp = null;

            logger.info('Timestamp column missing in CSV upload - will prompt user for time range');
        }
    } else {
        // Use provided values or defaults when timestamp exists
        // If we detected a data range from timestamp, use it
        data_days = detectedDateRange || parseNumber(data.data_days, 'data_days', 1) || 30;
        granularity_hourly = parseNumber(data.granularity_hourly, 'granularity_hourly', 0, 1) || 1;
        // workload_pattern is a calculated column - set to null if user-provided
        workload_pattern = data.workload_pattern === null ? null : (parseNumber(data.workload_pattern, 'workload_pattern', 0, 3) || 0);
        date_source = detectedDateRange ? 'timestamp_inferred' : 'csv';
        timestamp_status = 'present';
        confidence_cap = null;
        timestamp = timestampValue;
    }

    return {
        cloud,
        account_id,
        region: normalizedRegion,
        instance_id,
        instance_type,
        os,
        os_source,
        timestamp,

        // Original 12 features
        cpu_avg,
        cpu_p95,
        memory_avg,
        memory_p95,
        disk_read_iops,
        disk_write_iops,
        network_in_bytes,
        network_out_bytes,
        vcpu_count,
        ram_gb,
        uptime_hours,
        cost_per_month,

        // CSV fallback values (for catalog lookup)
        csv_vcpu_count,
        csv_ram_gb,

        // New 12 features
        cpu_spike_ratio,
        memory_spike_ratio,
        cpu_throttle_percent,
        peak_hour_avg_cpu,
        off_peak_avg_cpu,
        weekend_avg_cpu,
        memory_swap_usage,
        disk_latency_ms,
        network_packet_loss,
        data_days,
        granularity_hourly,
        workload_pattern,

        // Timestamp metadata
        missing_timestamp,
        date_source,
        timestamp_status,
        confidence_cap,

        // Calculated columns metadata
        calculated_columns_detected,

        // Catalog priority flag
        has_instance_type,

        source: 'file'
    };
}

/**
 * Normalize VM data from cloud API source
 */
function normalizeFromCloud(rawData, cloud) {
    try {
        // Cloud-specific normalization
        if (cloud === 'aws') {
            return normalizeAWS(rawData);
        } else if (cloud === 'gcp') {
            return normalizeGCP(rawData);
        } else if (cloud === 'azure') {
            return normalizeAzure(rawData);
        } else {
            throw new NormalizationError(`Unsupported cloud provider: ${cloud}`, 'cloud');
        }
    } catch (error) {
        if (error instanceof NormalizationError) {
            throw error;
        }
        throw new NormalizationError(
            `Failed to normalize ${cloud} data: ${error.message}`,
            'cloud_data'
        );
    }
}

/**
 * Normalize AWS EC2 instance data
 * ENHANCED: Includes running_hours_last_14d, memory_metrics_source, missing_metrics, burstable, architecture
 * CRITICAL: Preserve null for missing metrics (don't convert to 0)
 */
function normalizeAWS(rawData) {
    // Determine metrics status based on what's available
    let metrics_status = 'complete';
    const missing_metrics = [];

    // Check CPU metrics (required)
    if (rawData.cpu_avg === null || rawData.cpu_avg === undefined) {
        missing_metrics.push('cpu_avg');
    }
    if (rawData.cpu_p95 === null || rawData.cpu_p95 === undefined) {
        missing_metrics.push('cpu_p95');
    }

    // Check memory metrics (optional but important)
    if (rawData.memory_avg === null || rawData.memory_avg === undefined) {
        missing_metrics.push('memory_avg');
    }
    if (rawData.memory_p95 === null || rawData.memory_p95 === undefined) {
        missing_metrics.push('memory_p95');
    }

    // Set metrics_status based on what's missing
    if (missing_metrics.includes('cpu_avg') || missing_metrics.includes('cpu_p95')) {
        metrics_status = 'missing';
    } else if (missing_metrics.length > 0) {
        metrics_status = 'partial';
    }

    return {
        cloud: 'aws',
        account_id: parseString(rawData.account_id, 'account_id') || 'unknown',
        region: parseString(rawData.region, 'region', true),
        instance_id: parseString(rawData.instance_id, 'instance_id', true),
        instance_type: parseString(rawData.instance_type, 'instance_type', true),
        os: parseString(rawData.os, 'os') || 'unknown',
        os_source: parseString(rawData.os_source, 'os_source') || 'unresolved',
        os_confidence: parseString(rawData.os_confidence, 'os_confidence') || 'low',

        // Instance specs
        vcpu_count: parseNumber(rawData.vcpu_count, 'vcpu_count', 0) ?? null,
        ram_gb: parseNumber(rawData.ram_gb, 'ram_gb', 0) ?? null,
        architecture: parseString(rawData.architecture, 'architecture') ?? null,
        burstable: rawData.burstable === true,
        gpu: rawData.gpu === true,

        // Metrics from CloudWatch - PRESERVE NULL (use ?? instead of ||)
        cpu_avg: parseNumber(rawData.cpu_avg, 'cpu_avg', 0, 100) ?? null,
        cpu_p95: parseNumber(rawData.cpu_p95, 'cpu_p95', 0, 100) ?? null,
        memory_avg: parseNumber(rawData.memory_avg, 'memory_avg', 0, 100) ?? null,
        memory_p95: parseNumber(rawData.memory_p95, 'memory_p95', 0, 100) ?? null,
        cpu_credit_balance: parseNumber(rawData.cpu_credit_balance, 'cpu_credit_balance', 0) ?? null,
        disk_read_iops: parseNumber(rawData.disk_read_iops, 'disk_read_iops', 0) ?? 0,
        disk_write_iops: parseNumber(rawData.disk_write_iops, 'disk_write_iops', 0) ?? 0,
        network_in_bytes: parseNumber(rawData.network_in_bytes ?? rawData.network_in, 'network_in_bytes', 0) ?? 0,
        network_out_bytes: parseNumber(rawData.network_out_bytes ?? rawData.network_out, 'network_out_bytes', 0) ?? 0,

        // Metrics status
        metrics_status: rawData.metrics_status ?? metrics_status,
        memory_metrics_source: parseString(rawData.memory_metrics_source, 'memory_metrics_source') ?? 'unavailable',
        missing_metrics: Array.isArray(rawData.missing_metrics) ? rawData.missing_metrics : missing_metrics,

        // Running hours and metrics window
        running_hours_last_14d: parseNumber(rawData.running_hours_last_14d, 'running_hours_last_14d', 0) ?? 0,
        metrics_window_days: parseNumber(rawData.metrics_window_days, 'metrics_window_days', 0) ?? (parseInt(process.env.METRICS_WINDOW_DAYS) || 30),

        // Cost
        cost_per_month: parseNumber(rawData.cost_per_month, 'cost_per_month', 0) ?? 0,

        source: 'cloud'
    };
}


/**
 * Normalize GCP Compute Engine instance data
 * ENHANCED: Includes running_hours_last_14d, memory_metrics_source, missing_metrics, region/zone separation
 * CRITICAL: Preserve null for missing metrics (don't convert to 0)
 */
function normalizeGCP(rawData) {
    // Determine metrics status based on what's available
    let metrics_status = 'complete';
    const missing_metrics = [];

    // Check CPU metrics (required)
    if (rawData.cpu_avg === null || rawData.cpu_avg === undefined) {
        missing_metrics.push('cpu_avg');
    }
    if (rawData.cpu_p95 === null || rawData.cpu_p95 === undefined) {
        missing_metrics.push('cpu_p95');
    }

    // Check memory metrics (optional but important)
    if (rawData.memory_avg === null || rawData.memory_avg === undefined) {
        missing_metrics.push('memory_avg');
    }
    if (rawData.memory_p95 === null || rawData.memory_p95 === undefined) {
        missing_metrics.push('memory_p95');
    }

    // Set metrics_status based on what's missing
    if (missing_metrics.includes('cpu_avg') || missing_metrics.includes('cpu_p95')) {
        metrics_status = 'missing';
    } else if (missing_metrics.length > 0) {
        metrics_status = 'partial';
    }

    return {
        cloud: 'gcp',
        account_id: parseString(rawData.project_id, 'account_id') || 'unknown',
        region: parseString(rawData.region, 'region', true), // Separate region field
        zone: parseString(rawData.zone, 'zone') ?? null, // Separate zone field
        instance_id: parseString(rawData.instance_id, 'instance_id', true),
        instance_type: parseString(rawData.instance_type ?? rawData.machine_type, 'instance_type', true),
        os: parseString(rawData.os, 'os') || 'unknown',
        os_source: parseString(rawData.os_source, 'os_source') || 'unresolved',
        os_confidence: parseString(rawData.os_confidence, 'os_confidence') || 'low',

        // Instance specs
        vcpu_count: parseNumber(rawData.vcpu_count, 'vcpu_count', 0) ?? null,
        ram_gb: parseNumber(rawData.ram_gb, 'ram_gb', 0) ?? null,
        architecture: parseString(rawData.architecture, 'architecture') ?? null,

        // Metrics from Cloud Monitoring - PRESERVE NULL (use ?? instead of ||)
        cpu_avg: parseNumber(rawData.cpu_avg, 'cpu_avg', 0, 100) ?? null,
        cpu_p95: parseNumber(rawData.cpu_p95, 'cpu_p95', 0, 100) ?? null,
        memory_avg: parseNumber(rawData.memory_avg, 'memory_avg', 0, 100) ?? null,
        memory_p95: parseNumber(rawData.memory_p95, 'memory_p95', 0, 100) ?? null,
        disk_read_iops: parseNumber(rawData.disk_read_iops, 'disk_read_iops', 0) ?? 0,
        disk_write_iops: parseNumber(rawData.disk_write_iops, 'disk_write_iops', 0) ?? 0,
        network_in_bytes: parseNumber(rawData.network_in_bytes ?? rawData.network_in, 'network_in_bytes', 0) ?? 0,
        network_out_bytes: parseNumber(rawData.network_out_bytes ?? rawData.network_out, 'network_out_bytes', 0) ?? 0,

        // Metrics status
        metrics_status: rawData.metrics_status ?? metrics_status,
        memory_metrics_source: parseString(rawData.memory_metrics_source, 'memory_metrics_source') ?? 'unavailable',
        missing_metrics: Array.isArray(rawData.missing_metrics) ? rawData.missing_metrics : missing_metrics,

        // Running hours and metrics window
        running_hours_last_14d: parseNumber(rawData.running_hours_last_14d, 'running_hours_last_14d', 0) ?? 0,
        metrics_window_days: parseNumber(rawData.metrics_window_days, 'metrics_window_days', 0) ?? (parseInt(process.env.METRICS_WINDOW_DAYS) || 30),

        // Cost
        cost_per_month: parseNumber(rawData.cost_per_month, 'cost_per_month', 0) ?? 0,

        source: 'cloud'
    };
}

/**
 * Normalize Azure VM data
 * ENHANCED: Includes running_hours_last_14d, memory_metrics_source, missing_metrics
 * CRITICAL: Preserve null for missing metrics (don't convert to 0)
 */
function normalizeAzure(rawData) {
    // Determine metrics status based on what's available
    let metrics_status = 'complete';
    const missing_metrics = [];

    // Check CPU metrics (required)
    if (rawData.cpu_avg === null || rawData.cpu_avg === undefined) {
        missing_metrics.push('cpu_avg');
    }
    if (rawData.cpu_p95 === null || rawData.cpu_p95 === undefined) {
        missing_metrics.push('cpu_p95');
    }

    // Check memory metrics (optional but important)
    if (rawData.memory_avg === null || rawData.memory_avg === undefined) {
        missing_metrics.push('memory_avg');
    }
    if (rawData.memory_p95 === null || rawData.memory_p95 === undefined) {
        missing_metrics.push('memory_p95');
    }

    // Set metrics_status based on what's missing
    if (missing_metrics.includes('cpu_avg') || missing_metrics.includes('cpu_p95')) {
        metrics_status = 'missing';
    } else if (missing_metrics.length > 0) {
        metrics_status = 'partial';
    }

    return {
        cloud: 'azure',
        account_id: parseString(rawData.subscription_id ?? rawData.account_id, 'account_id') || 'unknown',
        region: parseString(rawData.region ?? rawData.location, 'region', true),
        instance_id: parseString(rawData.instance_id ?? rawData.vm_id, 'instance_id', true),
        instance_type: parseString(rawData.instance_type ?? rawData.vm_size, 'instance_type', true),
        os: parseString(rawData.os ?? rawData.os_type, 'os') || 'unknown',
        os_source: parseString(rawData.os_source, 'os_source') || 'unresolved',
        os_confidence: parseString(rawData.os_confidence, 'os_confidence') || 'low',

        // Instance specs
        vcpu_count: parseNumber(rawData.vcpu_count, 'vcpu_count', 0) ?? null,
        ram_gb: parseNumber(rawData.ram_gb, 'ram_gb', 0) ?? null,
        architecture: parseString(rawData.architecture, 'architecture') ?? null,

        // Metrics from Azure Monitor - PRESERVE NULL (use ?? instead of ||)
        cpu_avg: parseNumber(rawData.cpu_avg, 'cpu_avg', 0, 100) ?? null,
        cpu_p95: parseNumber(rawData.cpu_p95, 'cpu_p95', 0, 100) ?? null,
        memory_avg: parseNumber(rawData.memory_avg, 'memory_avg', 0, 100) ?? null,
        memory_p95: parseNumber(rawData.memory_p95, 'memory_p95', 0, 100) ?? null,
        disk_read_iops: parseNumber(rawData.disk_read_iops, 'disk_read_iops', 0) ?? 0,
        disk_write_iops: parseNumber(rawData.disk_write_iops, 'disk_write_iops', 0) ?? 0,
        network_in_bytes: parseNumber(rawData.network_in_bytes ?? rawData.network_in, 'network_in_bytes', 0) ?? 0,
        network_out_bytes: parseNumber(rawData.network_out_bytes ?? rawData.network_out, 'network_out_bytes', 0) ?? 0,

        // Metrics status
        metrics_status: rawData.metrics_status ?? metrics_status,
        memory_metrics_source: parseString(rawData.memory_metrics_source, 'memory_metrics_source') ?? 'unavailable',
        missing_metrics: Array.isArray(rawData.missing_metrics) ? rawData.missing_metrics : missing_metrics,

        // Running hours and metrics window
        running_hours_last_14d: parseNumber(rawData.running_hours_last_14d, 'running_hours_last_14d', 0) ?? 0,
        metrics_window_days: parseNumber(rawData.metrics_window_days, 'metrics_window_days', 0) ?? (parseInt(process.env.METRICS_WINDOW_DAYS) || 30),

        // Cost
        cost_per_month: parseNumber(rawData.cost_per_month, 'cost_per_month', 0) ?? 0,

        source: 'cloud'
    };
}


/**
 * Main normalization function
 * @param {Object} rawData - Raw VM data
 * @param {String} source - 'file' or 'cloud'
 * @param {Object} options - Additional options (userMappings, cloud, timestampRange)
 * @returns {Object} Normalized VM data
 */
function normalizeVM(rawData, source, options = {}) {
    try {
        if (source === 'file') {
            return normalizeFromFile(rawData, options.userMappings, options.timestampRange);
        } else if (source === 'cloud') {
            if (!options.cloud) {
                throw new NormalizationError('Cloud provider must be specified for cloud source', 'cloud');
            }
            return normalizeFromCloud(rawData, options.cloud);
        } else {
            throw new NormalizationError(`Invalid source: ${source}. Must be 'file' or 'cloud'`, 'source');
        }
    } catch (error) {
        if (error instanceof NormalizationError) {
            logger.warn(`Normalization failed: ${error.message}`, { rawData, source });
            throw error;
        }
        logger.error(`Unexpected normalization error: ${error.message}`, { rawData, source, error });
        throw new NormalizationError(`Normalization failed: ${error.message}`, 'unknown');
    }
}

/**
 * Validate required columns are present in CSV
 */
function validateRequiredColumns(headers) {
    const mapped = headers.map(h => mapColumnName(h)).filter(Boolean);

    const required = ['instance_id', 'instance_type', 'region'];
    const missing = required.filter(field => !mapped.includes(field));

    if (missing.length > 0) {
        return {
            valid: false,
            missing,
            message: `Missing required columns: ${missing.join(', ')}`
        };
    }

    return { valid: true };
}

module.exports = {
    normalizeVM,
    autoDetectColumns,
    validateRequiredColumns,
    detectCloudType,
    inferOSFromInstanceType,
    normalizeRegionName,
    NormalizationError
};
