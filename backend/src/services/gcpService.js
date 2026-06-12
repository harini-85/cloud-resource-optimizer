const { ProjectsClient } = require('@google-cloud/resource-manager');
const { Storage } = require('@google-cloud/storage');
const { MetricServiceClient } = require('@google-cloud/monitoring');
const { RecommenderClient } = require('@google-cloud/recommender');
const Resource = require('../models/Resource');
const logger = require('../utils/logger');
const { normalizeVM } = require('./normalizationService');
const { enrichVMBatch, trackUnresolvableInstance } = require('./enrichmentService');
const { processVMsInBatches } = require('./mlService');
const { validateVMBatch, markVMWithError } = require('../utils/dataValidator');

/**
 * Detect OS from GCP Compute Engine instance
 * AUTHORITATIVE METHOD: Uses disk image information
 * Returns: { os_type: 'Linux'|'Windows'|'unknown', os_source: 'cloud'|'inferred'|'unresolved', os_confidence: 'high'|'medium'|'low' }
 */
const detectGCPOS = (instance) => {
    try {
        logger.info(`[OS Detection] Starting for GCP instance ${instance.name}`);

        // Step A: Check disks for OS information
        if (instance.disks && instance.disks.length > 0) {
            const bootDisk = instance.disks.find(d => d.boot === true) || instance.disks[0];
            logger.info(`[OS Detection] Boot disk found: ${bootDisk ? 'YES' : 'NO'}`);

            if (bootDisk && bootDisk.licenses) {
                const licenses = bootDisk.licenses.map(l => l.toLowerCase());
                const licensesStr = licenses.join(' ');
                logger.info(`[OS Detection] Disk licenses: ${licensesStr || 'NONE'}`);

                // Check for Windows licenses
                if (licensesStr.includes('windows')) {
                    logger.info(`[OS Detection] ✅ OS detected from disk licenses: Windows`);
                    return { os_type: 'Windows', os_source: 'cloud', os_confidence: 'high' };
                }

                // Check for Linux variants
                if (licensesStr.includes('ubuntu') || licensesStr.includes('debian') ||
                    licensesStr.includes('centos') || licensesStr.includes('rhel') ||
                    licensesStr.includes('suse') || licensesStr.includes('linux')) {
                    logger.info(`[OS Detection] ✅ OS detected from disk licenses: Linux`);
                    return { os_type: 'Linux', os_source: 'cloud', os_confidence: 'high' };
                }

                logger.warn(`[OS Detection] Licenses present but no OS match: ${licensesStr}`);
            } else {
                logger.warn(`[OS Detection] No licenses found on boot disk`);
            }

            // Step B: Check source image
            if (bootDisk && bootDisk.source) {
                const source = bootDisk.source.toLowerCase();
                logger.info(`[OS Detection] Checking disk source: ${source}`);

                if (source.includes('windows')) {
                    logger.info(`[OS Detection] ✅ OS inferred from disk source: Windows`);
                    return { os_type: 'Windows', os_source: 'inferred', os_confidence: 'medium' };
                }

                if (source.includes('ubuntu') || source.includes('debian') ||
                    source.includes('centos') || source.includes('rhel') ||
                    source.includes('suse') || source.includes('linux')) {
                    logger.info(`[OS Detection] ✅ OS inferred from disk source: Linux`);
                    return { os_type: 'Linux', os_source: 'inferred', os_confidence: 'medium' };
                }

                logger.warn(`[OS Detection] Disk source present but no OS match`);
            } else {
                logger.warn(`[OS Detection] No disk source available`);
            }
        } else {
            logger.warn(`[OS Detection] No disks found for instance ${instance.name}`);
        }

        // Step C: Check machine type and tags (last resort)
        // GCP instances are predominantly Linux unless explicitly Windows
        logger.info(`[OS Detection] ⚠️ OS defaulting to Linux for GCP instance ${instance.name} (most common)`);
        return { os_type: 'Linux', os_source: 'inferred', os_confidence: 'low' };

    } catch (error) {
        logger.error(`[OS Detection] ❌ OS detection failed for GCP instance ${instance.name}: ${error.message}`);
        return { os_type: 'unknown', os_source: 'unresolved', os_confidence: 'low' };
    }
};

/**
 * Fetch real GCP machine type specifications
 * GCP provides guestCpus and memoryMb in the machine type details
 */
const getGCPSpecsFromAPI = async (compute, projectId, zone, machineType, credentialsObj) => {
    try {
        // GCP provides machine type details through the MachineTypes API
        // CRITICAL: Pass credentials to the client
        const machineTypesClient = new compute.MachineTypesClient({
            credentials: credentialsObj
        });

        const [machineTypeInfo] = await machineTypesClient.get({
            project: projectId,
            zone: zone,
            machineType: machineType
        });

        if (machineTypeInfo) {
            const vCpu = machineTypeInfo.guestCpus || null;
            const memoryMb = machineTypeInfo.memoryMb || null;
            const memoryGb = memoryMb ? memoryMb / 1024 : null; // NO ROUNDING - exact value

            logger.info(`[GCP Specs] ${machineType}: ${vCpu} vCPU, ${memoryGb} GB RAM (from GCP API)`);

            return {
                vcpu_count: vCpu,
                ram_gb: memoryGb
            };
        }

        logger.warn(`[GCP Specs] No data returned for ${machineType}, using fallback`);

        // Track unknown machine type in database for future updates
        await trackUnresolvableInstance('gcp', machineType, zone);

        return getGCPSpecsFallback(machineType);

    } catch (error) {
        logger.error(`[GCP Specs] Failed to fetch specs for ${machineType}: ${error.message}`);

        // Track unknown machine type in database
        await trackUnresolvableInstance('gcp', machineType, zone);

        return getGCPSpecsFallback(machineType);
    }
};

/**
 * Fallback function when GCP MachineTypes API fails
 * Returns NULL instead of mock data - frontend will display 'N/A'
 */
const getGCPSpecsFallback = (machineType) => {
    logger.warn(`[GCP Specs] No specs available for ${machineType} - returning NULL`);
    return { vcpu_count: null, ram_gb: null };
};

/**
 * Fetch Cloud Monitoring metrics for a GCP VM instance
 * Returns average and p95 CPU and memory utilization
 * FIXED: Proper null handling, 14-day window, no estimates
 */
/**
 * Fetch Cloud Monitoring metrics for a GCP instance
 * Returns average and p95 CPU and memory utilization
 * ENHANCED: State-aware fetching, agent detection, time window validation, running hours calculation
 * 
 * @param {Object} monitoringClient - GCP Cloud Monitoring client
 * @param {string} projectId - GCP project ID
 * @param {string} instanceId - GCP instance ID
 * @param {string} zone - GCP zone
 * @param {string} state - Instance state (RUNNING, STOPPED, TERMINATED, etc.)
 * @returns {Object} Normalized metrics with status indicators
 */
const fetchCloudMonitoringMetrics = async (monitoringClient, projectId, instanceId, zone, state = 'UNKNOWN') => {
    const METRICS_WINDOW_DAYS = parseInt(process.env.METRICS_WINDOW_DAYS) || 30;

    // CRITICAL: Determine instance state FIRST before fetching metrics
    // Requirement 1.1: State Detection Precedes Metrics Collection
    logger.info(`[Metrics] GCP instance ${instanceId} state: ${state}`);

    // CRITICAL: Return early with null metrics if instance is not RUNNING
    // Requirement 1.2: Stopped Instances Return Null Metrics
    if (state !== 'RUNNING') {
        logger.info(`[Metrics] Skipping metrics for ${instanceId} - instance is ${state} (not RUNNING)`);
        return {
            cpu_avg: null,
            cpu_p95: null,
            memory_avg: null,
            memory_p95: null,
            network_in_bytes: 0,
            network_out_bytes: 0,
            disk_read_iops: 0,
            disk_write_iops: 0,
            metrics_status: 'instance_stopped',
            memory_metrics_source: 'unavailable',
            missing_metrics: [],
            running_hours_last_14d: 0,
            metrics_window_days: METRICS_WINDOW_DAYS,
            state: state,
            state_checked_at: new Date().toISOString()
        };
    }

    // Instance is RUNNING - proceed with metrics collection
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - METRICS_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    logger.info(`[Metrics] Fetching Cloud Monitoring metrics for ${instanceId} (${METRICS_WINDOW_DAYS}-day window)`);

    let metrics_status = 'missing';
    let memory_metrics_source = 'unavailable';
    let missing_metrics = [];
    let cpu_avg = null;
    let cpu_p95 = null;
    let memory_avg = null;
    let memory_p95 = null;
    let running_hours_last_14d = 0;

    try {
        // CPU Utilization
        const cpuRequest = {
            name: `projects/${projectId}`,
            filter: `metric.type="compute.googleapis.com/instance/cpu/utilization" AND resource.labels.instance_id="${instanceId}"`,
            interval: {
                startTime: { seconds: Math.floor(startTime.getTime() / 1000) },
                endTime: { seconds: Math.floor(endTime.getTime() / 1000) }
            },
            aggregation: {
                alignmentPeriod: { seconds: 3600 }, // 1 hour
                perSeriesAligner: 'ALIGN_MEAN',
                crossSeriesReducer: 'REDUCE_MEAN'
            }
        };

        const [cpuTimeSeries] = await monitoringClient.listTimeSeries(cpuRequest);

        if (cpuTimeSeries && cpuTimeSeries.length > 0) {
            const cpuValues = cpuTimeSeries[0].points?.map(p => p.value.doubleValue * 100) || [];
            if (cpuValues.length > 0) {
                cpu_avg = cpuValues.reduce((sum, val) => sum + val, 0) / cpuValues.length;
                cpuValues.sort((a, b) => a - b);
                const p95Index = Math.floor(cpuValues.length * 0.95);
                cpu_p95 = cpuValues[p95Index] || cpu_avg * 1.2;

                // Calculate running hours from number of datapoints (each datapoint = 1 hour)
                running_hours_last_14d = cpuValues.length;

                metrics_status = 'partial'; // CPU present, memory unknown
                logger.info(`Cloud Monitoring CPU metrics for ${instanceId}: avg=${cpu_avg.toFixed(2)}%, p95=${cpu_p95.toFixed(2)}%, running_hours=${running_hours_last_14d}`);
            } else {
                logger.warn(`No Cloud Monitoring CPU datapoints for ${instanceId}`);
                missing_metrics.push('cpu_avg', 'cpu_p95');
            }
        } else {
            missing_metrics.push('cpu_avg', 'cpu_p95');
        }

        // Memory Utilization (requires Cloud Monitoring agent / Ops Agent)
        try {
            const memRequest = {
                name: `projects/${projectId}`,
                filter: `metric.type="agent.googleapis.com/memory/percent_used" AND resource.labels.instance_id="${instanceId}"`,
                interval: {
                    startTime: { seconds: Math.floor(startTime.getTime() / 1000) },
                    endTime: { seconds: Math.floor(endTime.getTime() / 1000) }
                },
                aggregation: {
                    alignmentPeriod: { seconds: 3600 },
                    perSeriesAligner: 'ALIGN_MEAN',
                    crossSeriesReducer: 'REDUCE_MEAN'
                }
            };

            const [memTimeSeries] = await monitoringClient.listTimeSeries(memRequest);

            if (memTimeSeries && memTimeSeries.length > 0) {
                const memValues = memTimeSeries[0].points?.map(p => p.value.doubleValue) || [];
                if (memValues.length > 0) {
                    memory_avg = memValues.reduce((sum, val) => sum + val, 0) / memValues.length;
                    memValues.sort((a, b) => a - b);
                    const p95Index = Math.floor(memValues.length * 0.95);
                    memory_p95 = memValues[p95Index] || memory_avg * 1.2;

                    memory_metrics_source = 'available';

                    if (cpu_avg !== null) {
                        metrics_status = 'complete'; // Both CPU and memory present
                    }

                    logger.info(`Cloud Monitoring memory metrics for ${instanceId}: avg=${memory_avg.toFixed(2)}%, p95=${memory_p95.toFixed(2)}%`);
                } else {
                    logger.info(`No memory metrics for ${instanceId} - Ops Agent not installed (this is normal)`);
                    memory_metrics_source = 'agent_required';
                    missing_metrics.push('memory_avg', 'memory_p95');
                }
            } else {
                logger.info(`No memory metrics for ${instanceId} - Ops Agent not installed (expected)`);
                memory_metrics_source = 'agent_required';
                missing_metrics.push('memory_avg', 'memory_p95');
            }
        } catch (memError) {
            // Memory metrics not available - this is EXPECTED and NORMAL
            logger.info(`Memory metrics not available for ${instanceId} - Ops Agent not installed (expected)`);
            memory_metrics_source = 'agent_required';
            missing_metrics.push('memory_avg', 'memory_p95');
        }

        // Network metrics
        const networkInRequest = {
            name: `projects/${projectId}`,
            filter: `metric.type="compute.googleapis.com/instance/network/received_bytes_count" AND resource.labels.instance_id="${instanceId}"`,
            interval: {
                startTime: { seconds: Math.floor(startTime.getTime() / 1000) },
                endTime: { seconds: Math.floor(endTime.getTime() / 1000) }
            },
            aggregation: {
                alignmentPeriod: { seconds: 3600 },
                perSeriesAligner: 'ALIGN_RATE',
                crossSeriesReducer: 'REDUCE_MEAN'
            }
        };

        const networkOutRequest = {
            name: `projects/${projectId}`,
            filter: `metric.type="compute.googleapis.com/instance/network/sent_bytes_count" AND resource.labels.instance_id="${instanceId}"`,
            interval: {
                startTime: { seconds: Math.floor(startTime.getTime() / 1000) },
                endTime: { seconds: Math.floor(endTime.getTime() / 1000) }
            },
            aggregation: {
                alignmentPeriod: { seconds: 3600 },
                perSeriesAligner: 'ALIGN_RATE',
                crossSeriesReducer: 'REDUCE_MEAN'
            }
        };

        const [networkInSeries, networkOutSeries] = await Promise.all([
            monitoringClient.listTimeSeries(networkInRequest),
            monitoringClient.listTimeSeries(networkOutRequest)
        ]);

        const networkInValues = networkInSeries[0]?.[0]?.points?.map(p => p.value.doubleValue) || [];
        const networkOutValues = networkOutSeries[0]?.[0]?.points?.map(p => p.value.doubleValue) || [];

        const network_in_bytes = networkInValues.length > 0
            ? networkInValues.reduce((sum, val) => sum + val, 0) / networkInValues.length
            : 0;

        const network_out_bytes = networkOutValues.length > 0
            ? networkOutValues.reduce((sum, val) => sum + val, 0) / networkOutValues.length
            : 0;

        // CRITICAL: Check if uptime is sufficient for the metrics window
        // Calculate uptime in days
        const uptime_days = running_hours_last_14d / 24;

        // Requirement 1.1-1.4: Dynamic time window calculation based on uptime
        let metrics_window_days;
        if (uptime_days >= 30) {
            metrics_window_days = 30;
        } else if (uptime_days >= 14) {
            metrics_window_days = 14;
        } else if (uptime_days >= 7) {
            metrics_window_days = 7;
        } else {
            // Requirement 1.4: Mark as INSUFFICIENT_DATA if uptime < 7 days
            metrics_status = 'insufficient_data';
            metrics_window_days = Math.floor(uptime_days);
            logger.warn(`Insufficient uptime for ${instanceId}: ${uptime_days.toFixed(1)} days < 7 days required`);
        }

        logger.info(`Metrics window for ${instanceId}: ${metrics_window_days} days (uptime: ${uptime_days.toFixed(1)} days)`);

        // Return metrics with proper null handling
        return {
            cpu_avg: cpu_avg !== null ? Math.round(cpu_avg * 10) / 10 : null,
            cpu_p95: cpu_p95 !== null ? Math.round(cpu_p95 * 10) / 10 : null,
            memory_avg: memory_avg !== null ? Math.round(memory_avg * 10) / 10 : null,
            memory_p95: memory_p95 !== null ? Math.round(memory_p95 * 10) / 10 : null,
            network_in_bytes: Math.round(network_in_bytes),
            network_out_bytes: Math.round(network_out_bytes),
            disk_read_iops: 0,
            disk_write_iops: 0,
            metrics_status, // 'complete', 'partial', 'insufficient_data', or 'missing'
            memory_metrics_source, // 'available', 'agent_required', or 'unavailable'
            missing_metrics, // Array of missing metric names
            running_hours_last_14d, // Running hours in the last 14 days
            metrics_window_days, // Calculated based on uptime (7, 14, or 30 days)
            state: state,
            state_checked_at: new Date().toISOString()
        };
    } catch (error) {
        logger.error(`Failed to fetch Cloud Monitoring metrics for ${instanceId}:`, error.message);
        logger.error(`Error details:`, error);

        // Return null values if metrics fetch fails - DO NOT return fake data
        return {
            cpu_avg: null,
            cpu_p95: null,
            memory_avg: null,
            memory_p95: null,
            network_in_bytes: 0,
            network_out_bytes: 0,
            disk_read_iops: 0,
            disk_write_iops: 0,
            metrics_status: 'missing',
            memory_metrics_source: 'unavailable',
            missing_metrics: ['cpu_avg', 'cpu_p95', 'memory_avg', 'memory_p95'],
            running_hours_last_14d: 0,
            metrics_window_days: parseInt(process.env.METRICS_WINDOW_DAYS) || 30,
            state: state,
            state_checked_at: new Date().toISOString()
        };
    }
};


/**
 * Test GCP connection - allows partial access
 * Returns success if credentials are valid, even if some APIs are inaccessible
 */
/**
 * Helper function to add timeout to promises
 */
const withTimeout = (promise, timeoutMs, errorMessage) => {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
        )
    ]);
};

/**
 * Test GCP connection and validate permissions
 * Returns detailed permission status with missing permissions and impact
 * ENHANCED: Added timeout handling to prevent hanging
 */
const testConnection = async (creds) => {
    if (!creds.serviceAccountJson) {
        throw new Error("Missing GCP Service Account JSON");
    }

    let credentialsObj;
    try {
        credentialsObj = JSON.parse(creds.serviceAccountJson);
    } catch (e) {
        throw new Error("Invalid JSON format in Service Account Key");
    }

    const projectId = credentialsObj.project_id;
    if (!projectId) {
        throw new Error("Invalid Service Account JSON: Missing project_id");
    }

    const clientEmail = credentialsObj.client_email;
    if (!clientEmail) {
        throw new Error("Invalid Service Account JSON: Missing client_email");
    }

    // Test basic authentication first - this will fail if credentials are deleted
    // Add 10 second timeout for authentication
    try {
        const { GoogleAuth } = require('google-auth-library');
        const auth = new GoogleAuth({
            credentials: credentialsObj,
            scopes: ['https://www.googleapis.com/auth/cloud-platform.read-only']
        });

        // Try to get an access token - this will fail if credentials are deleted/revoked
        const client = await auth.getClient();
        await withTimeout(
            client.getAccessToken(),
            10000,
            'GCP authentication timed out after 10 seconds'
        );
        logger.info('[GCP Auth] ✓ Credentials are valid and can authenticate');
    } catch (authError) {
        logger.error('[GCP Auth] ✗ Authentication failed - credentials may be deleted or revoked');
        if (authError.message.includes('timed out')) {
            throw new Error('GCP authentication timed out. Please check your network connection and try again.');
        }
        throw new Error('GCP credentials are invalid or have been deleted from Google Cloud');
    }

    // Details for success response
    let projectDetails = { projectId, clientEmail };
    let connectedVia = "";
    const missingPermissions = [];
    const impact = [];
    let connectionStatus = 'full';
    let hasAnyAccess = false;

    // 1. Try Cloud Resource Manager (Optional) - 5 second timeout
    try {
        const client = new ProjectsClient({ credentials: credentialsObj });
        const [projects] = await withTimeout(
            client.searchProjects({ query: `id:${projectId}` }),
            5000,
            'Cloud Resource Manager API timed out'
        );
        if (projects && projects.length > 0) {
            projectDetails = { ...projectDetails, ...projects[0] };
        }
        connectedVia = "Cloud Resource Manager";
        hasAnyAccess = true;
        logger.info('[GCP Permissions] ✓ Cloud Resource Manager accessible');
    } catch (e) {
        logger.info('[GCP Permissions] ℹ Cloud Resource Manager not accessible (optional)');
    }

    // 2. Test Compute Viewer role (VM inventory) - 5 second timeout
    try {
        const compute = require('@google-cloud/compute');
        const instancesClient = new compute.InstancesClient({ credentials: credentialsObj });

        const request = {
            project: projectId,
            maxResults: 1
        };

        const iterable = instancesClient.aggregatedListAsync(request);
        const iterator = iterable[Symbol.asyncIterator]();
        await withTimeout(
            iterator.next(),
            5000,
            'Compute Engine API timed out'
        );

        if (!connectedVia) connectedVia = "Compute Engine API";
        hasAnyAccess = true;
        logger.info('[GCP Permissions] ✓ Compute Viewer role available');
    } catch (e) {
        if (e.code === 7 || e.message.includes('PERMISSION_DENIED')) {
            missingPermissions.push('Compute Viewer role');
            impact.push('Cannot fetch VM instances');
            connectionStatus = 'partial';
            logger.warn('[GCP Permissions] ✗ Compute Viewer role missing');
        } else if (e.message.includes('timed out')) {
            logger.warn('[GCP Permissions] ⏱ Compute Engine API timed out');
        }
    }

    // 3. Test Machine Types access (VM specifications) - 5 second timeout
    try {
        const compute = require('@google-cloud/compute');
        const machineTypesClient = new compute.MachineTypesClient({ credentials: credentialsObj });

        const request = {
            project: projectId,
            zone: 'us-central1-a', // Test with a common zone
            maxResults: 1
        };

        await withTimeout(
            machineTypesClient.list(request),
            5000,
            'Machine Types API timed out'
        );
        logger.info('[GCP Permissions] ✓ Machine Types API available');
    } catch (e) {
        if (e.code === 7 || e.message.includes('PERMISSION_DENIED')) {
            missingPermissions.push('Compute resource access');
            impact.push('Cannot fetch VM specifications');
            connectionStatus = 'partial';
            logger.warn('[GCP Permissions] ✗ Machine Types API access missing');
        } else if (e.message.includes('timed out')) {
            logger.warn('[GCP Permissions] ⏱ Machine Types API timed out');
        }
    }

    // 4. Test Monitoring Viewer role (metrics access) - 5 second timeout
    try {
        const monitoring = require('@google-cloud/monitoring');
        const monitoringClient = new monitoring.MetricServiceClient({ credentials: credentialsObj });

        // Try to list metric descriptors (lightweight test)
        const request = {
            name: `projects/${projectId}`,
            filter: 'metric.type="compute.googleapis.com/instance/cpu/utilization"',
            pageSize: 1
        };

        await withTimeout(
            monitoringClient.listMetricDescriptors(request),
            5000,
            'Monitoring API timed out'
        );
        logger.info('[GCP Permissions] ✓ Monitoring Viewer role available');
    } catch (e) {
        if (e.code === 7 || e.message.includes('PERMISSION_DENIED')) {
            missingPermissions.push('Monitoring Viewer role');
            impact.push('Cannot fetch CPU and memory metrics');
            connectionStatus = 'partial';
            logger.warn('[GCP Permissions] ✗ Monitoring Viewer role missing');
        } else if (e.message.includes('timed out')) {
            logger.warn('[GCP Permissions] ⏱ Monitoring API timed out');
        }
    }

    // 5. Test Billing Viewer role (pricing access) - Optional - 5 second timeout
    try {
        const { CloudBillingClient } = require('@google-cloud/billing');
        const billingClient = new CloudBillingClient({ credentials: credentialsObj });

        // Try to get billing info for the project
        const [billingInfo] = await withTimeout(
            billingClient.getProjectBillingInfo({
                name: `projects/${projectId}`
            }),
            5000,
            'Billing API timed out'
        );

        if (billingInfo) {
            logger.info('[GCP Permissions] ✓ Billing Viewer role available');
        }
    } catch (e) {
        if (e.code === 7 || e.message.includes('PERMISSION_DENIED')) {
            missingPermissions.push('Billing Viewer role');
            impact.push('Live pricing unavailable - will use cached pricing');
            connectionStatus = 'partial';
            logger.warn('[GCP Permissions] ✗ Billing Viewer role missing');
        } else if (e.message.includes('timed out')) {
            logger.warn('[GCP Permissions] ⏱ Billing API timed out');
        }
    }

    // 6. Try Cloud Storage API (Optional) - 5 second timeout
    try {
        const storage = new Storage({ credentials: credentialsObj });
        await withTimeout(
            storage.getBuckets({ maxResults: 1 }),
            5000,
            'Cloud Storage API timed out'
        );

        if (!connectedVia) connectedVia = "Cloud Storage API";
        hasAnyAccess = true;
        logger.info('[GCP Permissions] ✓ Cloud Storage API accessible');
    } catch (e) {
        logger.info('[GCP Permissions] ℹ Cloud Storage not accessible (optional)');
    }

    // 7. Test GCP Recommender API (Optional) - 5 second timeout
    try {
        const recommenderTestResults = await withTimeout(
            testGCPRecommenderConnection(credentialsObj, projectId),
            5000,
            'GCP Recommender API timed out'
        );

        if (recommenderTestResults.success) {
            logger.info('[GCP Permissions] ✓ GCP Recommender API accessible');
            if (recommenderTestResults.machineTypeRecommender) {
                logger.info('[GCP Permissions] ✓ Machine Type Recommender available');
            }
            if (recommenderTestResults.idleResourceRecommender) {
                logger.info('[GCP Permissions] ✓ Idle Resource Recommender available');
            }
        } else {
            missingPermissions.push('Recommender API access');
            impact.push('VM rightsizing recommendations unavailable');
            connectionStatus = 'partial';
            logger.warn('[GCP Permissions] ✗ GCP Recommender API not accessible');
        }
    } catch (e) {
        if (e.message.includes('timed out')) {
            logger.warn('[GCP Permissions] ⏱ GCP Recommender API timed out');
        } else {
            missingPermissions.push('Recommender API access');
            impact.push('VM rightsizing recommendations unavailable');
            connectionStatus = 'partial';
            logger.warn('[GCP Permissions] ✗ GCP Recommender API not accessible');
        }
    }

    // Allow connection with valid credentials even if no APIs are accessible
    if (!hasAnyAccess) {
        logger.warn(`⚠️  No GCP APIs accessible - credentials may be deleted or revoked`);

        // This indicates the credentials are invalid or deleted
        throw new Error('GCP credentials are invalid or have been deleted. No API access available.');
    }

    const message = connectionStatus === 'full'
        ? `Connected to GCP via ${connectedVia}. Project: ${projectId} with full permissions`
        : `Connected to GCP via ${connectedVia}. Project: ${projectId} with partial permissions`;

    return {
        success: true,
        message,
        connection_status: connectionStatus,
        missing_permissions: missingPermissions,
        impact,
        details: projectDetails
    };
};

/**
 * Fetch resources with graceful error handling and ML analysis
 * Continues fetching available resources even if some services fail
 */
const fetchResources = async (userId, creds) => {
    const errors = [];
    const instances = [];
    let vmCount = 0;
    let bucketCount = 0;

    try {
        const credentialsObj = JSON.parse(creds.serviceAccountJson);
        const projectId = credentialsObj.project_id;

        // Initialize monitoring client
        const monitoringClient = new MetricServiceClient({ credentials: credentialsObj });

        // Try to fetch VM instances
        try {
            const compute = require('@google-cloud/compute');
            const instancesClient = new compute.InstancesClient({ credentials: credentialsObj });

            const request = { project: projectId };
            const aggListIterable = instancesClient.aggregatedListAsync(request);

            for await (const [zone, instancesObject] of aggListIterable) {
                if (instancesObject.instances && instancesObject.instances.length > 0) {
                    for (const instance of instancesObject.instances) {
                        // Process ALL instances regardless of status
                        const instanceStatus = instance.status || 'UNKNOWN'; // RUNNING, STOPPED, TERMINATED, etc.

                        logger.info(`Processing GCP instance ${instance.name} (${instanceStatus})`);

                        const zoneName = zone.replace('zones/', '');
                        const machineType = instance.machineType?.split('/').pop() || 'unknown';

                        // Fetch real specs from GCP API
                        const specs = await getGCPSpecsFromAPI(compute, projectId, zoneName, machineType, credentialsObj);
                        const vcpu_count = specs.vcpu_count;
                        const ram_gb = specs.ram_gb;

                        // Fetch Cloud Monitoring metrics only for running instances
                        let metrics;
                        if (instanceStatus === 'RUNNING') {
                            logger.info(`Fetching metrics for GCP instance ${instance.name} (${instanceStatus})`);
                            metrics = await fetchCloudMonitoringMetrics(
                                monitoringClient,
                                projectId,
                                instance.id.toString(),
                                zoneName,
                                instanceStatus
                            );
                        } else {
                            // For stopped/terminated instances, use zero metrics
                            logger.info(`Skipping metrics for GCP instance ${instance.name} (${instanceStatus})`);
                            metrics = {
                                cpu_avg: 0,
                                cpu_p95: 0,
                                memory_avg: 0,
                                memory_p95: 0,
                                disk_read_iops: 0,
                                disk_write_iops: 0,
                                network_in_bytes: 0,
                                network_out_bytes: 0
                            };
                        }

                        // Calculate uptime
                        const creationTime = new Date(instance.creationTimestamp);
                        const uptime_hours = Math.round((Date.now() - creationTime.getTime()) / (1000 * 60 * 60));

                        // Detect OS using authoritative method
                        const osInfo = detectGCPOS(instance);
                        logger.info(`GCP instance ${instance.name}: OS=${osInfo.os_type}, source=${osInfo.os_source}, confidence=${osInfo.os_confidence}`);

                        // Fetch cost estimate for this instance
                        let vmCost = 0;
                        let vmCurrency = 'USD';
                        let priceSource = 'estimated';
                        try {
                            const costEstimate = estimateGCPCost(machineType, zoneName);
                            vmCost = costEstimate.monthly;
                            vmCurrency = costEstimate.currency;
                            priceSource = 'estimated'; // GCP costs are estimated based on pricing calculator
                            logger.info(`✅ Estimated cost for ${instance.name}: ${vmCost.toFixed(2)} ${vmCurrency}/month`);
                        } catch (costError) {
                            logger.error(`❌ Failed to estimate cost for ${instance.name}: ${costError.message}`);
                            vmCost = 0;
                            vmCurrency = 'USD';
                            priceSource = 'unavailable';
                        }

                        const instanceData = {
                            instance_id: instance.id.toString(),
                            instance_type: machineType,
                            region: zoneName,
                            cloud: 'gcp',
                            state: instanceStatus, // Add instance status
                            os: osInfo.os_type, // Use detected OS
                            os_source: osInfo.os_source,
                            os_confidence: osInfo.os_confidence,
                            vcpu_count,
                            ram_gb,
                            cpu_avg: metrics.cpu_avg,
                            cpu_p95: metrics.cpu_p95,
                            memory_avg: metrics.memory_avg,
                            memory_p95: metrics.memory_p95,
                            disk_read_iops: metrics.disk_read_iops,
                            disk_write_iops: metrics.disk_write_iops,
                            network_in_bytes: metrics.network_in_bytes,
                            network_out_bytes: metrics.network_out_bytes,
                            uptime_hours,
                            cost_per_month: vmCost,
                            currency: vmCurrency,
                            price_source: priceSource,
                            source: 'cloud',
                            name: instance.name,
                            creation_time: instance.creationTimestamp
                        };

                        // Log detailed instance information
                        logger.info(`\n${'='.repeat(80)}`);
                        logger.info(`📊 GCP INSTANCE DETAILS FETCHED`);
                        logger.info(`${'='.repeat(80)}`);
                        logger.info(`Instance Name: ${instance.name}`);
                        logger.info(`Instance ID: ${instance.id}`);
                        logger.info(`Machine Type: ${machineType}`);
                        logger.info(`Zone: ${zoneName}`);
                        logger.info(`Cost: ${vmCost.toFixed(2)} ${vmCurrency}/month (${priceSource})`);
                        logger.info(`Status: ${instanceStatus}`);
                        logger.info(`Creation Time: ${instance.creationTimestamp}`);
                        logger.info(`\n--- Hardware Specifications ---`);
                        logger.info(`vCPU Count: ${vcpu_count || 'N/A'}`);
                        logger.info(`RAM (GB): ${ram_gb || 'N/A'}`);
                        logger.info(`\n--- Operating System ---`);
                        logger.info(`OS Type: ${osInfo.os_type}`);
                        logger.info(`OS Source: ${osInfo.os_source}`);
                        logger.info(`OS Confidence: ${osInfo.os_confidence}`);
                        logger.info(`\n--- Metrics (Last 14 Days) ---`);
                        logger.info(`CPU Average: ${metrics.cpu_avg !== null ? metrics.cpu_avg + '%' : 'N/A'}`);
                        logger.info(`CPU P95: ${metrics.cpu_p95 !== null ? metrics.cpu_p95 + '%' : 'N/A'}`);
                        logger.info(`Memory Average: ${metrics.memory_avg !== null ? metrics.memory_avg + '%' : 'N/A (Agent Required)'}`);
                        logger.info(`Memory P95: ${metrics.memory_p95 !== null ? metrics.memory_p95 + '%' : 'N/A (Agent Required)'}`);
                        logger.info(`Network In: ${metrics.network_in_bytes} bytes`);
                        logger.info(`Network Out: ${metrics.network_out_bytes} bytes`);
                        logger.info(`Disk Read IOPS: ${metrics.disk_read_iops}`);
                        logger.info(`Disk Write IOPS: ${metrics.disk_write_iops}`);
                        logger.info(`Uptime Hours: ${uptime_hours} hours`);
                        logger.info(`${'='.repeat(80)}\n`);

                        instances.push(instanceData);

                        vmCount++;
                    }
                }
            }
            logger.info(`\n${'='.repeat(80)}`);
            logger.info(`✅ GCP FETCH SUMMARY`);
            logger.info(`${'='.repeat(80)}`);
            logger.info(`Total Instances Collected: ${vmCount}`);
            logger.info(`Project ID: ${projectId}`);
            logger.info(`User ID: ${userId}`);

            // Count by state
            const stateCount = {};
            instances.forEach(inst => {
                stateCount[inst.state] = (stateCount[inst.state] || 0) + 1;
            });
            logger.info(`\nInstances by Status:`);
            Object.entries(stateCount).forEach(([state, count]) => {
                logger.info(`  ${state}: ${count}`);
            });

            // Count by OS
            const osCount = {};
            instances.forEach(inst => {
                osCount[inst.os] = (osCount[inst.os] || 0) + 1;
            });
            logger.info(`\nInstances by OS:`);
            Object.entries(osCount).forEach(([os, count]) => {
                logger.info(`  ${os}: ${count}`);
            });

            // Count by zone
            const zoneCount = {};
            instances.forEach(inst => {
                zoneCount[inst.region] = (zoneCount[inst.region] || 0) + 1;
            });
            logger.info(`\nInstances by Zone:`);
            Object.entries(zoneCount).forEach(([zone, count]) => {
                logger.info(`  ${zone}: ${count}`);
            });

            logger.info(`${'='.repeat(80)}\n`);
        } catch (error) {
            logger.error(`❌ Failed to fetch GCP VM instances: ${error.message}`);
            errors.push({
                service: 'Compute Engine',
                error: error.message,
                userMessage: 'Unable to fetch VM instances. Please ensure Compute Engine API is enabled and you have Compute Viewer permissions.'
            });
        }

        // Normalize and enrich instances
        if (instances.length > 0) {
            // Validate data before processing
            const validationResults = validateVMBatch(instances, 'gcp');

            // Mark invalid VMs with errors
            const validatedInstances = instances.map(vm => {
                const validation = require('../utils/dataValidator').validateVMData(vm, 'gcp');
                if (!validation.valid) {
                    return markVMWithError(vm, validation.errors);
                }
                return vm;
            });

            const normalizedVMs = validatedInstances.map(vm => normalizeVM(vm, 'cloud', { cloud: 'gcp' }));
            const enrichedVMs = await enrichVMBatch(normalizedVMs);

            // Send to ML service for analysis
            logger.info(`Sending ${enrichedVMs.length} GCP instances to ML service`);
            const mlResults = await processVMsInBatches(enrichedVMs, 100);
            logger.info(`Received ${mlResults.length} predictions from ML service`);

            // Store results in MongoDB
            for (const result of mlResults) {
                const finding = result.prediction || 'Optimal';
                const savings = result.recommendation?.monthly_savings || result.savings || 0;
                const originalInstance = instances.find(i => i.instance_id === result.instance_id);

                // Extract instance family from instance type (e.g., 'n1' from 'n1-standard-2')
                const instanceFamily = result.instance_type ? result.instance_type.split('-')[0] : null;

                // Determine architecture (GCP has both x86_64 and arm64/T2A instances)
                const architecture = result.instance_type?.startsWith('t2a') || result.instance_type?.startsWith('tau') ? 'arm64' : 'x86_64';

                // Parse GCP instance specs (e.g., n1-standard-2 = 2 vCPU, 7.5 GB)
                const getGCPSpecs = (type) => {
                    const match = type?.match(/-(\d+)$/);
                    const vcpu = match ? parseInt(match[1]) : 2;
                    const memoryMultiplier = type?.includes('highmem') ? 6.5 : type?.includes('highcpu') ? 0.9 : 3.75;
                    return { vCpu: vcpu, memoryGb: vcpu * memoryMultiplier };
                };

                const recommendedSpecs = result.recommendation?.suggested_instance ?
                    getGCPSpecs(result.recommendation.suggested_instance) : null;

                // CRITICAL DEBUG: Log what specs we're about to save
                logger.info(`[SPECS SAVE] ${result.instance_id}: originalInstance vCPU=${originalInstance?.vcpu_count}, RAM=${originalInstance?.ram_gb} | ML vCPU=${result.metrics?.vcpu_count}, RAM=${result.metrics?.ram_gb}`);
                logger.info(`[SPECS SAVE] ${result.instance_id}: SAVING vCPU=${originalInstance?.vcpu_count || null}, RAM=${originalInstance?.ram_gb || null}`);

                // FORCE DELETE OLD DATA to ensure fresh specs
                await Resource.deleteOne({ resourceId: result.instance_id });
                logger.info(`[SPECS SAVE] ${result.instance_id}: Deleted old record to force fresh data`);

                await Resource.findOneAndUpdate(
                    { resourceId: result.instance_id },
                    {
                        $set: {
                            userId,
                            resourceId: result.instance_id,
                            name: originalInstance?.name || result.instance_id,
                            provider: 'GCP',
                            service: 'Compute Engine',
                            region: result.region,
                            resourceType: result.instance_type,
                            state: originalInstance?.state || 'unknown', // Force update instance state
                            vCpu: originalInstance?.vcpu_count || null,
                            memoryGb: originalInstance?.ram_gb || null,

                            // Store metrics in the correct fields for frontend - PRESERVE NULL
                            avgCpuUtilization: result.metrics?.cpu_avg ?? null,
                            maxCpuUtilization: result.metrics?.cpu_p95 ?? null,
                            avgMemoryUtilization: result.metrics?.memory_avg ?? null,
                            maxMemoryUtilization: result.metrics?.memory_p95 ?? null,
                            networkIn: result.metrics?.network_in_bytes || 0,
                            networkOut: result.metrics?.network_out_bytes || 0,
                            diskReadBytes: result.metrics?.disk_read_iops || 0,
                            diskWriteBytes: result.metrics?.disk_write_iops || 0,

                            // NEW: CPU + Memory Recommendation System Metrics
                            cpu_avg: result.metrics?.cpu_avg ?? null,
                            cpu_p95: result.metrics?.cpu_p95 ?? null,
                            memory_avg: result.metrics?.memory_avg ?? null,
                            memory_p95: result.metrics?.memory_p95 ?? null,

                            // Store metrics status
                            metrics_status: result.metrics?.metrics_status || originalInstance?.metrics_status || 'missing',

                            // NEW: Metrics metadata for recommendation engine
                            running_hours_last_14d: result.metrics?.running_hours_last_14d || originalInstance?.running_hours_last_14d || 0,
                            metrics_window_days: result.metrics?.metrics_window_days || originalInstance?.metrics_window_days || null,
                            state_checked_at: result.metrics?.state_checked_at || originalInstance?.state_checked_at || new Date(),

                            // NEW: Memory metrics source tracking
                            memory_metrics_source: result.metrics?.memory_metrics_source || originalInstance?.memory_metrics_source || 'unavailable',
                            missing_metrics: result.metrics?.missing_metrics || originalInstance?.missing_metrics || [],

                            optimizationStatus: finding,
                            recommendation: result.ml_recommendation_text || result.recommendation,
                            estimatedSavings: savings,
                            estimatedMonthlyCost: originalInstance?.cost_per_month || result.currentCostPerMonth || result.current_cost_per_month || 0,
                            confidence: result.confidence || 0,
                            currentCost: originalInstance?.cost_per_month || result.currentCostPerMonth || result.current_cost_per_month || 0,
                            optimizedCost: result.optimizedCostPerMonth || (result.recommendation?.suggested_instance ?
                                ((originalInstance?.cost_per_month || result.currentCostPerMonth || result.current_cost_per_month || 0) - savings) : (originalInstance?.cost_per_month || result.currentCostPerMonth || result.current_cost_per_month || 0)),
                            recommendedType: result.recommendation?.suggested_instance || result.recommendedType || result.instance_type,
                            currency: originalInstance?.currency || 'USD',

                            // NEW: Pricing transparency fields
                            price_source: originalInstance?.price_source || 'estimated',
                            price_last_updated: new Date(),

                            // NEW: ML prediction confidence
                            prediction_confidence: result.confidence || 0,

                            // NEW: OS Detection fields
                            os_type: originalInstance?.os || 'unknown',
                            os_source: originalInstance?.os_source || 'unresolved',
                            os_confidence: originalInstance?.os_confidence || 'low',

                            // NEW: Recommended instance details
                            recommendedVcpu: recommendedSpecs?.vCpu || result.metrics?.vcpu_count,
                            recommendedMemory: recommendedSpecs?.memoryGb || result.metrics?.ram_gb,

                            // NEW: Architecture & compatibility
                            architecture: architecture,
                            instance_family: instanceFamily,
                            available_in_region: true, // Assume available since we're fetching from this region

                            // NEW: Recommendation reason
                            reason: result.ml_recommendation_text ||
                                (finding === 'Oversized' ? 'Instance is oversized based on current usage patterns. Downsizing will maintain performance while reducing costs.' :
                                    finding === 'Undersized' ? 'Instance is undersized and may experience performance issues. Upgrading is recommended.' :
                                        'Instance is optimally sized for current workload.'),

                            created: originalInstance?.creation_time,
                            lastFetched: Date.now(),
                            metrics: result.metrics
                        }
                    },
                    { upsert: true, new: true }
                ).then(savedResource => {
                    // VALIDATION: Verify saved data matches what we intended to save
                    if (savedResource.vCpu !== (originalInstance?.vcpu_count || null)) {
                        logger.error(`[VALIDATION ERROR] ${result.instance_id}: vCPU mismatch! Expected ${originalInstance?.vcpu_count}, got ${savedResource.vCpu}`);
                    }
                    if (savedResource.memoryGb !== (originalInstance?.ram_gb || null)) {
                        logger.error(`[VALIDATION ERROR] ${result.instance_id}: Memory mismatch! Expected ${originalInstance?.ram_gb}, got ${savedResource.memoryGb}`);
                    }
                    logger.info(`[VALIDATION OK] ${result.instance_id}: Saved vCPU=${savedResource.vCpu}, RAM=${savedResource.memoryGb}`);
                });
            }
        }

        // Try to fetch storage buckets
        try {
            const storage = new Storage({ credentials: credentialsObj });
            const [buckets] = await storage.getBuckets();
            for (const bucket of buckets) {
                await Resource.findOneAndUpdate(
                    { resourceId: bucket.id },
                    {
                        userId,
                        resourceId: bucket.id,
                        name: bucket.name,
                        provider: 'GCP',
                        service: 'Cloud Storage',
                        region: bucket.location,
                        resourceType: 'Bucket',
                        optimizationStatus: 'Optimal',
                        created: bucket.metadata.timeCreated,
                        lastFetched: Date.now()
                    },
                    { upsert: true }
                );
                bucketCount++;
            }
            logger.info(`✅ Fetched ${bucketCount} GCP storage buckets`);
        } catch (error) {
            logger.error(`❌ Failed to fetch GCP storage buckets: ${error.message}`);
            errors.push({
                service: 'Cloud Storage',
                error: error.message,
                userMessage: 'Unable to fetch storage buckets. Please ensure Cloud Storage API is enabled and you have Storage Object Viewer permissions.'
            });
        }

        const summary = {
            vmInstances: vmCount,
            storageBuckets: bucketCount,
            errors: errors.length > 0 ? errors : undefined
        };

        logger.info(`GCP sync complete for user ${userId}: ${vmCount} VMs analyzed, ${bucketCount} buckets${errors.length > 0 ? `, ${errors.length} errors` : ''}`);

        return summary;
    } catch (error) {
        logger.error("GCP Fetch Error", error);
        throw error;
    }
};

/**
 * Fetch GCP resources and return data directly (no MongoDB operations)
 * This method is used by the controller to fetch resources for localStorage storage
 * It reuses all the data fetching, normalization, enrichment, and ML prediction logic
 * from fetchResources() but skips MongoDB operations
 */
/**
 * Extract instance name from GCP recommendation resource path
 * Handles various resource path formats from GCP Recommender API
 * 
 * @param {Object} gcpRecommendation - GCP recommendation object
 * @returns {string|null} Instance name or null if not found
 */
const extractInstanceNameFromRecommendation = (gcpRecommendation) => {
    try {
        if (!gcpRecommendation || !gcpRecommendation.content) {
            return null;
        }

        const content = gcpRecommendation.content;
        if (!content.operationGroups || !Array.isArray(content.operationGroups)) {
            return null;
        }

        // Search through operation groups for instance references
        for (const operationGroup of content.operationGroups) {
            if (!operationGroup.operations || !Array.isArray(operationGroup.operations)) {
                continue;
            }

            for (const operation of operationGroup.operations) {
                if (operation.resourceType === 'compute.googleapis.com/Instance' && operation.resource) {
                    const resource = operation.resource;

                    // Try to extract from resource name path
                    if (resource.name && typeof resource.name === 'string') {
                        // Format: projects/{project}/zones/{zone}/instances/{instance-name}
                        const nameParts = resource.name.split('/');
                        const instanceIndex = nameParts.findIndex(part => part === 'instances');

                        if (instanceIndex !== -1 && instanceIndex < nameParts.length - 1) {
                            return nameParts[instanceIndex + 1];
                        }
                    }
                }
            }
        }

        return null;
    } catch (error) {
        logger.warn(`[GCP Recommender] Failed to extract instance name from recommendation: ${error.message}`);
        return null;
    }
};

// Global quota tracking for GCP Recommender API
const gcpQuotaTracker = {
    lastResetTime: Date.now(),
    requestCount: 0,
    maxRequestsPerMinute: 30, // More conservative limit

    // Circuit breaker state
    circuitBreakerState: 'CLOSED', // CLOSED, OPEN, HALF_OPEN
    lastFailureTime: null,
    failureCount: 0,
    circuitBreakerTimeout: 10 * 60 * 1000, // 10 minutes
    maxFailures: 3,

    canMakeRequest() {
        const now = Date.now();

        // Check circuit breaker first
        if (this.circuitBreakerState === 'OPEN') {
            const timeSinceFailure = now - this.lastFailureTime;
            if (timeSinceFailure < this.circuitBreakerTimeout) {
                logger.warn(`[GCP Quota] Circuit breaker OPEN - blocking requests for ${Math.round((this.circuitBreakerTimeout - timeSinceFailure) / 1000)}s more`);
                return false;
            } else {
                // Try to transition to HALF_OPEN
                this.circuitBreakerState = 'HALF_OPEN';
                logger.info(`[GCP Quota] Circuit breaker transitioning to HALF_OPEN - allowing test request`);
            }
        }

        // Reset counter every minute
        const timeSinceReset = now - this.lastResetTime;
        if (timeSinceReset >= 60000) {
            this.requestCount = 0;
            this.lastResetTime = now;
        }

        // Check quota limits
        const canMakeRequest = this.requestCount < this.maxRequestsPerMinute;
        if (!canMakeRequest) {
            logger.warn(`[GCP Quota] Rate limit reached: ${this.requestCount}/${this.maxRequestsPerMinute} requests this minute`);
        }

        return canMakeRequest;
    },

    recordRequest() {
        this.requestCount++;
        logger.info(`[GCP Quota] API requests this minute: ${this.requestCount}/${this.maxRequestsPerMinute}`);
    },

    recordSuccess() {
        if (this.circuitBreakerState === 'HALF_OPEN') {
            this.circuitBreakerState = 'CLOSED';
            this.failureCount = 0;
            logger.info(`[GCP Quota] Circuit breaker CLOSED - normal operation resumed`);
        }
    },

    recordFailure(error) {
        this.failureCount++;
        this.lastFailureTime = Date.now();

        if (error.code === 8 || error.message.includes('RESOURCE_EXHAUSTED')) {
            // Quota exhaustion - open circuit breaker immediately
            this.circuitBreakerState = 'OPEN';
            logger.error(`[GCP Quota] QUOTA EXHAUSTED - Circuit breaker OPEN for ${this.circuitBreakerTimeout / 1000}s`);
        } else if (this.failureCount >= this.maxFailures) {
            // Too many failures - open circuit breaker
            this.circuitBreakerState = 'OPEN';
            logger.error(`[GCP Quota] Too many failures (${this.failureCount}) - Circuit breaker OPEN for ${this.circuitBreakerTimeout / 1000}s`);
        }
    },

    getWaitTime() {
        if (this.circuitBreakerState === 'OPEN') {
            return this.circuitBreakerTimeout; // Wait full timeout period
        }

        const timeUntilReset = 60000 - (Date.now() - this.lastResetTime);
        return Math.max(timeUntilReset, 5000); // Minimum 5 seconds
    },

    isCircuitOpen() {
        return this.circuitBreakerState === 'OPEN';
    }
};

const fetchResourcesSync = async (userId, creds) => {
    const instances = [];

    try {
        const credentialsObj = JSON.parse(creds.serviceAccountJson);
        const projectId = credentialsObj.project_id;

        logger.info(`[Sync] Fetching GCP resources for user ${userId}, project ${projectId}`);

        // Initialize monitoring client
        const monitoringClient = new MetricServiceClient({ credentials: credentialsObj });

        // Initialize GCP Recommender client for fetching recommendations
        let recommenderClient = null;
        try {
            recommenderClient = initializeGCPRecommenderClient(credentialsObj);
            logger.info(`[Sync] GCP Recommender client initialized successfully for project ${projectId}`);
        } catch (recommenderError) {
            logger.warn(`[Sync] Failed to initialize GCP Recommender client: ${recommenderError.message} - continuing without recommendations`);
        }

        // Fetch VM instances
        try {
            const compute = require('@google-cloud/compute');
            const instancesClient = new compute.InstancesClient({ credentials: credentialsObj });

            const request = { project: projectId };
            const aggListIterable = instancesClient.aggregatedListAsync(request);

            for await (const [zone, instancesObject] of aggListIterable) {
                if (instancesObject.instances && instancesObject.instances.length > 0) {
                    for (const instance of instancesObject.instances) {
                        // Process ALL instances regardless of status
                        const instanceStatus = instance.status || 'UNKNOWN';

                        logger.info(`[Sync] Processing GCP instance ${instance.name} (${instanceStatus})`);

                        const zoneName = zone.replace('zones/', '');
                        const machineType = instance.machineType?.split('/').pop() || 'unknown';

                        // Fetch real specs from GCP API
                        const specs = await getGCPSpecsFromAPI(compute, projectId, zoneName, machineType, credentialsObj);
                        const vcpu_count = specs.vcpu_count;
                        const ram_gb = specs.ram_gb;

                        // Fetch Cloud Monitoring metrics only for running instances
                        let metrics;
                        if (instanceStatus === 'RUNNING') {
                            logger.info(`[Sync] Fetching metrics for GCP instance ${instance.name} (${instanceStatus})`);
                            metrics = await fetchCloudMonitoringMetrics(
                                monitoringClient,
                                projectId,
                                instance.id.toString(),
                                zoneName,
                                instanceStatus
                            );
                        } else {
                            // For stopped/terminated instances, use null metrics
                            logger.info(`[Sync] Skipping metrics for GCP instance ${instance.name} (${instanceStatus})`);
                            metrics = {
                                cpu_avg: null,
                                cpu_p95: null,
                                memory_avg: null,
                                memory_p95: null,
                                disk_read_iops: 0,
                                disk_write_iops: 0,
                                network_in_bytes: 0,
                                network_out_bytes: 0,
                                metrics_status: 'missing',
                                memory_metrics_source: 'unavailable',
                                missing_metrics: [],
                                running_hours_last_14d: 0
                            };
                        }

                        // Calculate uptime
                        const creationTime = new Date(instance.creationTimestamp);
                        const uptime_hours = Math.round((Date.now() - creationTime.getTime()) / (1000 * 60 * 60));

                        // Detect OS using authoritative method
                        const osInfo = detectGCPOS(instance);
                        logger.info(`[Sync] GCP instance ${instance.name}: OS=${osInfo.os_type}, source=${osInfo.os_source}, confidence=${osInfo.os_confidence}`);

                        // Fetch cost estimate for this instance
                        let vmCost = 0;
                        let vmCurrency = 'USD';
                        let priceSource = 'estimated';
                        try {
                            const costEstimate = estimateGCPCost(machineType, zoneName);
                            vmCost = costEstimate.monthly;
                            vmCurrency = costEstimate.currency;
                            priceSource = 'estimated'; // GCP costs are estimated based on pricing calculator
                            logger.info(`[Sync] ✅ Estimated cost for ${instance.name}: ${vmCost.toFixed(2)} ${vmCurrency}/month`);
                        } catch (costError) {
                            logger.error(`[Sync] ❌ Failed to estimate cost for ${instance.name}: ${costError.message}`);
                            vmCost = 0;
                            vmCurrency = 'USD';
                            priceSource = 'unavailable';
                        }

                        const instanceData = {
                            instance_id: instance.id.toString(),
                            instance_type: machineType,
                            region: zoneName,
                            cloud: 'gcp',
                            state: instanceStatus,
                            os: osInfo.os_type,
                            os_source: osInfo.os_source,
                            os_confidence: osInfo.os_confidence,
                            vcpu_count,
                            ram_gb,
                            architecture: machineType?.startsWith('t2a') || machineType?.startsWith('tau') ? 'arm64' : 'x86_64',
                            burstable: false, // GCP doesn't have burstable instances like AWS T-series
                            gpu: false, // Would need to check accelerators array
                            cpu_avg: metrics.cpu_avg,
                            cpu_p95: metrics.cpu_p95,
                            memory_avg: metrics.memory_avg,
                            memory_p95: metrics.memory_p95,
                            disk_read_iops: metrics.disk_read_iops,
                            disk_write_iops: metrics.disk_write_iops,
                            network_in_bytes: metrics.network_in_bytes,
                            network_out_bytes: metrics.network_out_bytes,
                            metrics_status: metrics.metrics_status,
                            memory_metrics_source: metrics.memory_metrics_source,
                            missing_metrics: metrics.missing_metrics,
                            running_hours_last_14d: metrics.running_hours_last_14d,
                            uptime_hours,
                            cost_per_month: vmCost,
                            currency: vmCurrency,
                            price_source: priceSource,
                            source: 'cloud',
                            name: instance.name,
                            creation_time: instance.creationTimestamp
                        };

                        instances.push(instanceData);
                    }
                }
            }

            logger.info(`\n${'='.repeat(80)}`);
            logger.info(`✅ [Sync] GCP FETCH SUMMARY`);
            logger.info(`${'='.repeat(80)}`);
            logger.info(`Total Instances Collected: ${instances.length}`);
            logger.info(`Project ID: ${projectId}`);
            logger.info(`User ID: ${userId}`);
            logger.info(`${'='.repeat(80)}\n`);

        } catch (error) {
            logger.error(`❌ [Sync] Failed to fetch GCP VM instances: ${error.message}`);
            throw error;
        }

        // Fetch GCP recommendations for all VMs
        let gcpRecommendations = [];
        if (recommenderClient && instances.length > 0) {
            try {
                // Check circuit breaker before attempting any recommendations
                if (gcpQuotaTracker.isCircuitOpen()) {
                    logger.warn(`[Sync] Circuit breaker OPEN - skipping GCP recommendations for ${instances.length} instances`);
                    logger.warn(`[Sync] Recommendations will be available when circuit breaker resets`);
                } else {
                    logger.info(`[Sync] Fetching GCP recommendations for ${instances.length} instances`);

                    // Group VMs by zone for efficient API calls
                    const vmsByZone = {};
                    instances.forEach(vm => {
                        const zone = vm.region; // region field contains the zone name
                        if (!vmsByZone[zone]) {
                            vmsByZone[zone] = [];
                        }
                        vmsByZone[zone].push(vm);
                    });

                    const zones = Object.keys(vmsByZone);
                    logger.info(`[Sync] Processing recommendations for zones: ${zones.join(', ')}`);

                    // Fetch recommendations for each zone with quota management
                    const zonePromises = zones.map(async (zone) => {
                        try {
                            // Double-check circuit breaker and quota before each zone
                            if (gcpQuotaTracker.isCircuitOpen()) {
                                logger.warn(`[Sync] Circuit breaker opened during processing - skipping zone ${zone}`);
                                return [];
                            }

                            if (!gcpQuotaTracker.canMakeRequest()) {
                                const waitTime = gcpQuotaTracker.getWaitTime();
                                logger.warn(`[Sync] GCP API quota limit reached, skipping zone ${zone} (would wait ${waitTime}ms)`);
                                return [];
                            }

                            gcpQuotaTracker.recordRequest();

                            const [machineTypeRecs, idleResourceRecs] = await Promise.all([
                                fetchMachineTypeRecommendations(recommenderClient, projectId, zone),
                                fetchIdleResourceRecommendations(recommenderClient, projectId, zone)
                            ]);

                            const allZoneRecommendations = [...machineTypeRecs, ...idleResourceRecs];
                            logger.info(`[Sync] Found ${allZoneRecommendations.length} recommendations for zone ${zone}`);

                            return allZoneRecommendations;
                        } catch (zoneError) {
                            logger.warn(`[Sync] Failed to fetch recommendations for zone ${zone}: ${zoneError.message}`);
                            return [];
                        }
                    });

                    const zoneResults = await Promise.allSettled(zonePromises);

                    // Combine all recommendations
                    zoneResults.forEach((result, index) => {
                        if (result.status === 'fulfilled') {
                            gcpRecommendations.push(...result.value);
                        } else {
                            logger.warn(`[Sync] Zone ${zones[index]} recommendations failed: ${result.reason?.message}`);
                        }
                    });

                    logger.info(`[Sync] Total GCP recommendations fetched: ${gcpRecommendations.length}`);
                }

            } catch (recommendationError) {
                logger.error(`[Sync] Failed to fetch GCP recommendations: ${recommendationError.message} - continuing without recommendations`);
            }
        } else {
            logger.info(`[Sync] Skipping GCP recommendations: ${!recommenderClient ? 'no recommender client' : 'no instances'}`);
        }

        // Transform and match GCP recommendations to VMs
        const vmRecommendationMap = {};
        if (gcpRecommendations.length > 0) {
            logger.info(`[Sync] Transforming ${gcpRecommendations.length} GCP recommendations`);

            gcpRecommendations.forEach(gcpRec => {
                try {
                    // Extract instance name from recommendation resource path
                    const instanceName = extractInstanceNameFromRecommendation(gcpRec);
                    if (instanceName) {
                        // Find matching VM instance
                        const matchingVM = instances.find(vm => vm.name === instanceName);
                        if (matchingVM) {
                            // Transform the recommendation
                            const transformed = GCPRecommendationTransformer.transformRecommendation(gcpRec, matchingVM);
                            vmRecommendationMap[instanceName] = transformed;
                            logger.debug(`[Sync] Transformed recommendation for VM ${instanceName}: ${transformed.compute_optimizer_finding}`);
                        } else {
                            logger.debug(`[Sync] No matching VM found for recommendation instance: ${instanceName}`);
                        }
                    }
                } catch (transformError) {
                    logger.warn(`[Sync] Failed to transform GCP recommendation: ${transformError.message}`);
                }
            });

            logger.info(`[Sync] Successfully matched ${Object.keys(vmRecommendationMap).length} recommendations to VMs`);
        }

        // Apply GCP recommendations to VM instances
        instances.forEach(vm => {
            const recommendation = vmRecommendationMap[vm.name];
            if (recommendation) {
                // Apply GCP recommendation data
                vm.compute_optimizer_finding = recommendation.compute_optimizer_finding;
                vm.compute_optimizer_recommendation_options = recommendation.compute_optimizer_recommendation_options;
                vm.estimated_monthly_savings = recommendation.estimated_monthly_savings;

                // BUGFIX: Map GCP Recommender savings to potential_monthly_savings field
                // Extract cost impact from GCP Recommender and convert to positive savings
                // This ensures the frontend displays actual savings from GCP recommendations
                vm.potential_monthly_savings = recommendation.estimated_monthly_savings || 0;
                logger.debug(`[GCP Savings] ${vm.name}: $${vm.potential_monthly_savings}/month`);

                vm.gcp_recommendation_id = recommendation.gcp_recommendation_id;
                vm.gcp_recommender_type = recommendation.gcp_recommender_type;
                vm.recommendation_priority = recommendation.priority;
                vm.recommendation_confidence = recommendation.confidence;
                vm.recommendation_last_refresh = recommendation.last_refresh_time;
                vm.has_gcp_recommendation = true;
            } else {
                // No GCP recommendation found - indicate no recommendations available
                vm.compute_optimizer_finding = null; // Changed from 'Optimized' to null
                vm.compute_optimizer_recommendation_options = [];
                vm.estimated_monthly_savings = 0;
                vm.potential_monthly_savings = 0; // BUGFIX: Ensure field exists even when no recommendations
                vm.has_gcp_recommendation = false;
                vm.recommendation_unavailable_reason = gcpRecommendations.length === 0 ?
                    'No GCP recommendations available for this instance' :
                    'No matching GCP recommendation found for this instance';
            }
        });

        logger.info(`[Sync] Applied GCP recommendations to ${instances.length} VM instances`);

        // Validate data before processing
        const validationResults = validateVMBatch(instances, 'gcp');

        // Mark invalid VMs with errors
        const validatedInstances = instances.map(vm => {
            const validation = require('../utils/dataValidator').validateVMData(vm, 'gcp');
            if (!validation.valid) {
                return markVMWithError(vm, validation.errors);
            }
            return vm;
        });

        // Normalize and enrich instances
        const normalizedVMs = validatedInstances.map(vm => normalizeVM(vm, 'cloud', { cloud: 'gcp' }));
        const enrichedVMs = await enrichVMBatch(normalizedVMs);

        // Send to ML service for analysis
        let mlResults = [];
        if (enrichedVMs.length > 0) {
            logger.info(`[Sync] Sending ${enrichedVMs.length} GCP instances to ML service`);
            mlResults = await processVMsInBatches(enrichedVMs, 100);
            logger.info(`[Sync] Received ${mlResults.length} predictions from ML service`);
        }

        // Build final results array with all required fields for frontend
        const results = mlResults.map(result => {
            const finding = result.prediction || 'Optimal';
            const savings = result.recommendation?.monthly_savings || result.savings || 0;
            const originalInstance = instances.find(i => i.instance_id === result.instance_id);

            // Extract instance family from instance type (e.g., 'n1' from 'n1-standard-2')
            const instanceFamily = result.instance_type ? result.instance_type.split('-')[0] : null;

            // Determine architecture (GCP has both x86_64 and arm64/T2A instances)
            const architecture = result.instance_type?.startsWith('t2a') || result.instance_type?.startsWith('tau') ? 'arm64' : 'x86_64';

            // Parse GCP instance specs (e.g., n1-standard-2 = 2 vCPU, 7.5 GB)
            const getGCPSpecs = (type) => {
                const match = type?.match(/-(\d+)$/);
                const vcpu = match ? parseInt(match[1]) : 2;
                const memoryMultiplier = type?.includes('highmem') ? 6.5 : type?.includes('highcpu') ? 0.9 : 3.75;
                return { vCpu: vcpu, memoryGb: vcpu * memoryMultiplier };
            };

            const recommendedSpecs = result.recommendation?.suggested_instance ?
                getGCPSpecs(result.recommendation.suggested_instance) : null;

            return {
                // Core identification
                instance_id: result.instance_id,
                resourceId: result.instance_id,
                name: originalInstance?.name || result.instance_id,
                provider: 'GCP',
                service: 'Compute Engine',
                cloud: 'gcp',

                // Location and type
                region: result.region,
                resourceType: result.instance_type,
                instance_type: result.instance_type,
                state: originalInstance?.state || 'unknown',
                status: originalInstance?.state || 'unknown', // Add status field for frontend compatibility

                // Hardware specs
                vCpu: originalInstance?.vcpu_count || null,
                vcpu_count: originalInstance?.vcpu_count || null,
                memoryGb: originalInstance?.ram_gb || null,
                ram_gb: originalInstance?.ram_gb || null,
                architecture: architecture,
                burstable: false, // GCP doesn't have burstable instances like AWS
                gpu: false, // Would need to check accelerators

                // Metrics
                avgCpuUtilization: result.metrics?.cpu_avg ?? null,
                cpu_avg: result.metrics?.cpu_avg ?? null,
                maxCpuUtilization: result.metrics?.cpu_p95 ?? null,
                cpu_p95: result.metrics?.cpu_p95 ?? null,
                avgMemoryUtilization: result.metrics?.memory_avg ?? null,
                memory_avg: result.metrics?.memory_avg ?? null,
                maxMemoryUtilization: result.metrics?.memory_p95 ?? null,
                memory_p95: result.metrics?.memory_p95 ?? null,
                networkIn: result.metrics?.network_in_bytes || 0,
                network_in_bytes: result.metrics?.network_in_bytes || 0,
                networkOut: result.metrics?.network_out_bytes || 0,
                network_out_bytes: result.metrics?.network_out_bytes || 0,
                diskReadBytes: result.metrics?.disk_read_iops || 0,
                disk_read_iops: result.metrics?.disk_read_iops || 0,
                diskWriteBytes: result.metrics?.disk_write_iops || 0,
                disk_write_iops: result.metrics?.disk_write_iops || 0,
                metrics_status: originalInstance?.metrics_status || 'missing',
                memory_metrics_source: originalInstance?.memory_metrics_source || 'unavailable',

                // GCP Recommendations (prioritize GCP native recommendations over ML)
                optimizationStatus: originalInstance?.compute_optimizer_finding || finding,
                compute_optimizer_finding: originalInstance?.compute_optimizer_finding || (originalInstance?.has_gcp_recommendation === false ? null : 'Optimized'),
                compute_optimizer_recommendation_options: originalInstance?.compute_optimizer_recommendation_options || [],
                estimated_monthly_savings: originalInstance?.estimated_monthly_savings || 0,
                has_gcp_recommendation: originalInstance?.has_gcp_recommendation || false,
                recommendation_unavailable_reason: originalInstance?.recommendation_unavailable_reason || null,

                // ML Optimization (fallback when no GCP recommendations)
                recommendation: result.ml_recommendation_text || result.recommendation,
                estimatedSavings: originalInstance?.estimated_monthly_savings || savings,
                estimatedMonthlyCost: originalInstance?.cost_per_month || result.currentCostPerMonth || result.current_cost_per_month || 0,
                confidence: originalInstance?.recommendation_confidence || result.confidence || 0,
                prediction_confidence: result.confidence || 0,
                currentCost: originalInstance?.cost_per_month || result.currentCostPerMonth || result.current_cost_per_month || 0,
                optimizedCost: result.optimizedCostPerMonth || (result.recommendation?.suggested_instance ?
                    ((originalInstance?.cost_per_month || result.currentCostPerMonth || result.current_cost_per_month || 0) - savings) : (originalInstance?.cost_per_month || result.currentCostPerMonth || result.current_cost_per_month || 0)),
                recommendedType: result.recommendation?.suggested_instance || result.recommendedType || result.instance_type,
                recommendedVcpu: recommendedSpecs?.vCpu || result.metrics?.vcpu_count,
                recommendedMemory: recommendedSpecs?.memoryGb || result.metrics?.ram_gb,
                currency: originalInstance?.currency || 'USD',

                // GCP-specific recommendation metadata
                gcp_recommendation_id: originalInstance?.gcp_recommendation_id || null,
                gcp_recommender_type: originalInstance?.gcp_recommender_type || null,
                recommendation_priority: originalInstance?.recommendation_priority || null,
                recommendation_confidence: originalInstance?.recommendation_confidence || null,
                recommendation_last_refresh: originalInstance?.recommendation_last_refresh || null,

                // OS detection
                os: originalInstance?.os || 'unknown',
                os_type: originalInstance?.os || 'unknown',
                os_source: originalInstance?.os_source || 'unresolved',
                os_confidence: originalInstance?.os_confidence || 'low',

                // Pricing
                price_source: originalInstance?.price_source || 'estimated',
                price_last_updated: new Date(),

                // Architecture & compatibility
                instance_family: instanceFamily,
                available_in_region: true,

                // Recommendation reason (prioritize GCP recommendations)
                reason: originalInstance?.compute_optimizer_finding && originalInstance.compute_optimizer_finding !== 'Optimized' ?
                    `GCP Recommender suggests this instance is ${originalInstance.compute_optimizer_finding.toLowerCase()}` :
                    originalInstance?.recommendation_unavailable_reason ||
                    (result.ml_recommendation_text ||
                        (finding === 'Oversized' ? 'Instance is oversized based on current usage patterns. Downsizing will maintain performance while reducing costs.' :
                            finding === 'Undersized' ? 'Instance is undersized and may experience performance issues. Upgrading is recommended.' :
                                'Instance is optimally sized for current workload.')),

                // Timestamps
                created: originalInstance?.creation_time,
                creation_time: originalInstance?.creation_time,
                lastFetched: Date.now(),

                // Full metrics object
                metrics: result.metrics
            };
        });

        logger.info(`[Sync] GCP Compute Engine sync complete for user ${userId}: ${results.length} instances processed`);

        // Return array of resource objects (NO MongoDB operations)
        return results;

    } catch (error) {
        logger.error("[Sync] GCP Fetch Error", error);
        throw error;
    }
};

/**
 * Estimate GCP instance cost based on machine type and zone
 * Returns cost in USD with monthly and hourly rates
 */
const estimateGCPCost = (machineType, zone) => {
    // GCP pricing data (USD, as of 2024)
    // Source: https://cloud.google.com/compute/all-pricing
    const baseCosts = {
        // E2 Series (Cost-optimized)
        'e2-micro': { hourly: 0.008, monthly: 5.84 },
        'e2-small': { hourly: 0.017, monthly: 12.41 },
        'e2-medium': { hourly: 0.034, monthly: 24.82 },
        'e2-standard-2': { hourly: 0.067, monthly: 48.91 },
        'e2-standard-4': { hourly: 0.134, monthly: 97.82 },
        'e2-standard-8': { hourly: 0.268, monthly: 195.64 },

        // N1 Series (General purpose)
        'n1-standard-1': { hourly: 0.038, monthly: 27.74 },
        'n1-standard-2': { hourly: 0.076, monthly: 55.48 },
        'n1-standard-4': { hourly: 0.152, monthly: 110.96 },
        'n1-standard-8': { hourly: 0.304, monthly: 221.92 },
        'n1-highmem-2': { hourly: 0.095, monthly: 69.35 },
        'n1-highmem-4': { hourly: 0.190, monthly: 138.70 },
        'n1-highcpu-2': { hourly: 0.057, monthly: 41.61 },
        'n1-highcpu-4': { hourly: 0.114, monthly: 83.22 },

        // N2 Series (Balanced)
        'n2-standard-2': { hourly: 0.097, monthly: 70.81 },
        'n2-standard-4': { hourly: 0.194, monthly: 141.62 },
        'n2-standard-8': { hourly: 0.388, monthly: 283.24 },
        'n2-highmem-2': { hourly: 0.130, monthly: 94.90 },
        'n2-highmem-4': { hourly: 0.260, monthly: 189.80 },
        'n2-highcpu-2': { hourly: 0.071, monthly: 51.83 },
        'n2-highcpu-4': { hourly: 0.142, monthly: 103.66 },

        // N2D Series (AMD)
        'n2d-standard-2': { hourly: 0.087, monthly: 63.51 },
        'n2d-standard-4': { hourly: 0.174, monthly: 127.02 },
        'n2d-standard-8': { hourly: 0.348, monthly: 254.04 },

        // C2 Series (Compute-optimized)
        'c2-standard-4': { hourly: 0.209, monthly: 152.57 },
        'c2-standard-8': { hourly: 0.418, monthly: 305.14 },
        'c2-standard-16': { hourly: 0.836, monthly: 610.28 },

        // M1 Series (Memory-optimized)
        'm1-ultramem-40': { hourly: 4.493, monthly: 3279.77 },
        'm1-ultramem-80': { hourly: 8.986, monthly: 6559.54 },
        'm1-megamem-96': { hourly: 10.783, monthly: 7871.77 }
    };

    // Regional pricing multipliers
    const regionMultipliers = {
        // US regions
        'us-central1': 1.0,
        'us-east1': 1.0,
        'us-east4': 1.0,
        'us-west1': 1.0,
        'us-west2': 1.04,
        'us-west3': 1.04,
        'us-west4': 1.04,

        // Europe regions
        'europe-west1': 1.05,
        'europe-west2': 1.10,
        'europe-west3': 1.10,
        'europe-west4': 1.05,
        'europe-west6': 1.15,
        'europe-north1': 1.05,
        'europe-central2': 1.10,

        // Asia Pacific regions
        'asia-east1': 1.08,
        'asia-east2': 1.12,
        'asia-northeast1': 1.08,
        'asia-northeast2': 1.12,
        'asia-northeast3': 1.08,
        'asia-south1': 1.08,
        'asia-south2': 1.12,
        'asia-southeast1': 1.10,
        'asia-southeast2': 1.15,

        // Other regions
        'australia-southeast1': 1.12,
        'australia-southeast2': 1.15,
        'southamerica-east1': 1.20,
        'northamerica-northeast1': 1.05,
        'northamerica-northeast2': 1.10
    };

    // Extract region from zone (e.g., us-central1-a -> us-central1)
    const region = zone ? zone.split('-').slice(0, -1).join('-') : 'us-central1';

    // Get base cost for machine type
    const baseCost = baseCosts[machineType] || { hourly: 0.05, monthly: 36.50 };

    // Get regional multiplier
    const multiplier = regionMultipliers[region] || 1.0;

    // Calculate final cost
    return {
        hourly: baseCost.hourly * multiplier,
        monthly: baseCost.monthly * multiplier,
        currency: 'USD',
        isEstimated: true,
        region: region
    };
};

/**
 * GCP Recommender API Integration Functions
 * Provides VM rightsizing recommendations from Google Cloud Platform
 */

/**
 * GCP Recommendation Transformer Class
 * Transforms GCP Recommender API responses to standard format
 * Implements priority mapping, confidence calculation, and cost savings extraction
 */
class GCPRecommendationTransformer {
    /**
     * Map GCP recommendation priority to standard finding types
     * P1/P2 → Overprovisioned (high priority cost savings)
     * P3/P4 → Underprovisioned (low priority performance improvements)
     * 
     * @param {Object} gcpRecommendation - GCP recommendation object
     * @returns {string} Standard finding type
     */
    static transformRecommendationFinding(gcpRecommendation) {
        if (!gcpRecommendation || !gcpRecommendation.priority) {
            return 'Optimized';
        }

        const priority = gcpRecommendation.priority;
        const findingMap = {
            'P1': 'Overprovisioned', // High priority cost savings
            'P2': 'Overprovisioned', // Medium priority cost savings
            'P3': 'Underprovisioned', // Low priority performance improvements
            'P4': 'Underprovisioned'  // Very low priority improvements
        };

        return findingMap[priority] || 'Optimized';
    }

    /**
     * Calculate confidence score based on GCP priority levels
     * Higher priority recommendations get higher confidence scores
     * 
     * @param {Object} gcpRecommendation - GCP recommendation object
     * @returns {number} Confidence score between 0.5 and 0.9
     */
    static calculateConfidence(gcpRecommendation) {
        if (!gcpRecommendation || !gcpRecommendation.priority) {
            return 0.5; // Default confidence for unknown priority
        }

        const priority = gcpRecommendation.priority;
        const priorityMap = {
            'P1': 0.9, // High confidence for high priority
            'P2': 0.8, // Good confidence for medium priority
            'P3': 0.7, // Medium confidence for low priority
            'P4': 0.6  // Lower confidence for very low priority
        };

        return priorityMap[priority] || 0.5;
    }

    /**
     * Extract cost savings from GCP primaryImpact data
     * Converts various time periods to monthly values
     * BUGFIX: Convert negative cost impact to positive savings using Math.abs()
     * 
     * @param {Object} gcpRecommendation - GCP recommendation object
     * @returns {Object} Cost savings with amount and currency
     */
    static extractCostSavings(gcpRecommendation) {
        const defaultSavings = { amount: 0, currency: 'USD' };

        if (!gcpRecommendation || !gcpRecommendation.primaryImpact) {
            return defaultSavings;
        }

        const primaryImpact = gcpRecommendation.primaryImpact;

        // Check if this is a cost-related impact
        if (primaryImpact.category !== 'COST' || !primaryImpact.costProjection) {
            return defaultSavings;
        }

        const costProjection = primaryImpact.costProjection;
        const cost = costProjection.cost;

        if (!cost || !cost.units) {
            return defaultSavings;
        }

        const currencyCode = cost.currencyCode || 'USD';
        let monthlySavings = parseFloat(cost.units) || 0;

        // Convert to monthly savings based on duration
        if (costProjection.duration) {
            const duration = costProjection.duration;

            // Parse duration string (e.g., "2592000s" for 30 days)
            if (duration.includes('s')) {
                const seconds = parseInt(duration.replace('s', ''));
                const days = seconds / (24 * 60 * 60);

                if (days >= 365) {
                    // Annual to monthly
                    monthlySavings = monthlySavings / 12;
                } else if (days >= 30) {
                    // Already monthly or close to it
                    monthlySavings = monthlySavings;
                } else if (days >= 7) {
                    // Weekly to monthly
                    monthlySavings = monthlySavings * (30 / 7);
                } else {
                    // Daily to monthly
                    monthlySavings = monthlySavings * 30;
                }
            }
        }

        // BUGFIX: GCP Recommender returns negative cost impact (savings)
        // Convert to positive savings value: savings = Math.abs(costImpact)
        monthlySavings = Math.abs(monthlySavings);

        return {
            amount: Math.round(monthlySavings * 100) / 100, // Round to 2 decimal places
            currency: currencyCode
        };
    }

    /**
     * Extract recommended machine type from GCP recommendation content
     * Enhanced with comprehensive parsing, fallback handling, and error logging
     * 
     * @param {Object} gcpRecommendation - GCP recommendation object
     * @returns {string|null} Recommended machine type or null if not found
     */
    static extractRecommendedMachineType(gcpRecommendation) {
        try {
            // Input validation with detailed logging
            if (!gcpRecommendation) {
                logger.debug('[GCP Recommender] extractRecommendedMachineType: null recommendation object');
                return null;
            }

            if (!gcpRecommendation.content) {
                logger.debug('[GCP Recommender] extractRecommendedMachineType: missing content in recommendation');
                return null;
            }

            const content = gcpRecommendation.content;
            logger.debug('[GCP Recommender] extractRecommendedMachineType: processing recommendation content', {
                hasOperationGroups: !!content.operationGroups,
                operationGroupsType: typeof content.operationGroups,
                operationGroupsLength: Array.isArray(content.operationGroups) ? content.operationGroups.length : 'not array'
            });

            // Validate operation groups structure
            if (!content.operationGroups) {
                logger.warn('[GCP Recommender] extractRecommendedMachineType: missing operationGroups in content');
                return null;
            }

            if (!Array.isArray(content.operationGroups)) {
                logger.warn('[GCP Recommender] extractRecommendedMachineType: operationGroups is not an array', {
                    type: typeof content.operationGroups,
                    value: content.operationGroups
                });
                return null;
            }

            if (content.operationGroups.length === 0) {
                logger.debug('[GCP Recommender] extractRecommendedMachineType: empty operationGroups array');
                return null;
            }

            // Search through operation groups for machine type changes
            for (let groupIndex = 0; groupIndex < content.operationGroups.length; groupIndex++) {
                const operationGroup = content.operationGroups[groupIndex];

                logger.debug(`[GCP Recommender] extractRecommendedMachineType: processing operation group ${groupIndex}`, {
                    hasOperations: !!operationGroup?.operations,
                    operationsType: typeof operationGroup?.operations,
                    operationsLength: Array.isArray(operationGroup?.operations) ? operationGroup.operations.length : 'not array'
                });

                // Validate operation group structure
                if (!operationGroup || typeof operationGroup !== 'object') {
                    logger.warn(`[GCP Recommender] extractRecommendedMachineType: invalid operation group at index ${groupIndex}`, {
                        type: typeof operationGroup,
                        value: operationGroup
                    });
                    continue;
                }

                if (!operationGroup.operations) {
                    logger.debug(`[GCP Recommender] extractRecommendedMachineType: missing operations in group ${groupIndex}`);
                    continue;
                }

                if (!Array.isArray(operationGroup.operations)) {
                    logger.warn(`[GCP Recommender] extractRecommendedMachineType: operations is not an array in group ${groupIndex}`, {
                        type: typeof operationGroup.operations,
                        value: operationGroup.operations
                    });
                    continue;
                }

                // Process each operation in the group
                for (let opIndex = 0; opIndex < operationGroup.operations.length; opIndex++) {
                    const operation = operationGroup.operations[opIndex];

                    logger.debug(`[GCP Recommender] extractRecommendedMachineType: processing operation ${groupIndex}.${opIndex}`, {
                        action: operation?.action,
                        resourceType: operation?.resourceType,
                        hasResource: !!operation?.resource
                    });

                    // Validate operation structure
                    if (!operation || typeof operation !== 'object') {
                        logger.warn(`[GCP Recommender] extractRecommendedMachineType: invalid operation at ${groupIndex}.${opIndex}`, {
                            type: typeof operation,
                            value: operation
                        });
                        continue;
                    }

                    // Handle replace operations for machine type changes
                    if (operation.action === 'replace' &&
                        operation.resourceType === 'compute.googleapis.com/Instance') {

                        const machineType = this._extractMachineTypeFromReplaceOperation(operation, groupIndex, opIndex);
                        if (machineType) {
                            logger.info(`[GCP Recommender] extractRecommendedMachineType: found machine type from replace operation: ${machineType}`);
                            return machineType;
                        }
                    }

                    // Handle stop/delete operations for idle resources
                    if ((operation.action === 'stop' || operation.action === 'delete') &&
                        operation.resourceType === 'compute.googleapis.com/Instance') {

                        logger.info(`[GCP Recommender] extractRecommendedMachineType: found ${operation.action} operation for idle resource`);
                        return 'STOP'; // Special indicator for idle resources
                    }

                    // Handle other potential operation types with fallback
                    if (operation.action && operation.resourceType === 'compute.googleapis.com/Instance') {
                        logger.debug(`[GCP Recommender] extractRecommendedMachineType: unhandled operation type: ${operation.action}`);
                    }
                }
            }

            logger.debug('[GCP Recommender] extractRecommendedMachineType: no machine type found in any operation');
            return null;

        } catch (error) {
            logger.error('[GCP Recommender] extractRecommendedMachineType: unexpected error during parsing', {
                error: error.message,
                stack: error.stack,
                recommendationName: gcpRecommendation?.name,
                hasContent: !!gcpRecommendation?.content
            });

            // Return null on error to allow graceful degradation
            return null;
        }
    }

    /**
     * Helper method to extract machine type from replace operation resource
     * Handles various resource path formats and provides detailed error logging
     * 
     * @private
     * @param {Object} operation - The replace operation object
     * @param {number} groupIndex - Operation group index for logging
     * @param {number} opIndex - Operation index for logging
     * @returns {string|null} Extracted machine type or null
     */
    static _extractMachineTypeFromReplaceOperation(operation, groupIndex, opIndex) {
        try {
            const resource = operation.resource;

            if (!resource) {
                logger.debug(`[GCP Recommender] _extractMachineTypeFromReplaceOperation: missing resource in operation ${groupIndex}.${opIndex}`);
                return null;
            }

            if (typeof resource !== 'object') {
                logger.warn(`[GCP Recommender] _extractMachineTypeFromReplaceOperation: resource is not an object at ${groupIndex}.${opIndex}`, {
                    type: typeof resource,
                    value: resource
                });
                return null;
            }

            if (!resource.machineType) {
                logger.debug(`[GCP Recommender] _extractMachineTypeFromReplaceOperation: missing machineType in resource at ${groupIndex}.${opIndex}`, {
                    resourceKeys: Object.keys(resource)
                });
                return null;
            }

            const machineTypePath = resource.machineType;

            if (typeof machineTypePath !== 'string') {
                logger.warn(`[GCP Recommender] _extractMachineTypeFromReplaceOperation: machineType is not a string at ${groupIndex}.${opIndex}`, {
                    type: typeof machineTypePath,
                    value: machineTypePath
                });
                return null;
            }

            logger.debug(`[GCP Recommender] _extractMachineTypeFromReplaceOperation: parsing machine type path: ${machineTypePath}`);

            // Handle different possible path formats with fallback parsing
            let machineType = null;

            // Standard GCP resource path: projects/{project}/zones/{zone}/machineTypes/{machineType}
            if (machineTypePath.includes('/machineTypes/')) {
                const parts = machineTypePath.split('/');
                const machineTypeIndex = parts.findIndex(part => part === 'machineTypes');

                if (machineTypeIndex !== -1 && machineTypeIndex < parts.length - 1) {
                    machineType = parts[machineTypeIndex + 1];
                    logger.debug(`[GCP Recommender] _extractMachineTypeFromReplaceOperation: extracted from standard path: ${machineType}`);
                } else {
                    logger.warn(`[GCP Recommender] _extractMachineTypeFromReplaceOperation: malformed machineTypes path: ${machineTypePath}`);
                }
            }

            // Fallback: try splitting by '/' and taking the last part
            if (!machineType) {
                const pathParts = machineTypePath.split('/');
                if (pathParts.length > 0) {
                    const lastPart = pathParts[pathParts.length - 1];
                    if (lastPart && lastPart.trim()) {
                        machineType = lastPart.trim();
                        logger.debug(`[GCP Recommender] _extractMachineTypeFromReplaceOperation: extracted from fallback parsing: ${machineType}`);
                    }
                }
            }

            // Additional fallback: check if the entire path is just a machine type name
            if (!machineType && machineTypePath.trim() && !machineTypePath.includes('/')) {
                machineType = machineTypePath.trim();
                logger.debug(`[GCP Recommender] _extractMachineTypeFromReplaceOperation: using direct machine type name: ${machineType}`);
            }

            // Validate extracted machine type
            if (machineType) {
                // Basic validation: machine type should not be empty and should follow GCP naming patterns
                if (machineType.length === 0) {
                    logger.warn(`[GCP Recommender] _extractMachineTypeFromReplaceOperation: extracted empty machine type from: ${machineTypePath}`);
                    return null;
                }

                // Log successful extraction
                logger.debug(`[GCP Recommender] _extractMachineTypeFromReplaceOperation: successfully extracted machine type: ${machineType}`);
                return machineType;
            } else {
                logger.warn(`[GCP Recommender] _extractMachineTypeFromReplaceOperation: failed to extract machine type from path: ${machineTypePath}`);
                return null;
            }

        } catch (error) {
            logger.error(`[GCP Recommender] _extractMachineTypeFromReplaceOperation: error processing operation ${groupIndex}.${opIndex}`, {
                error: error.message,
                stack: error.stack,
                operation: operation
            });
            return null;
        }
    }

    /**
     * Create recommendation options array compatible with existing frontend
     * Formats data for RecommendationCard component
     * 
     * @param {string} recommendedMachineType - Recommended machine type
     * @param {Object} costSavings - Cost savings data
     * @param {number} confidence - Confidence score
     * @param {boolean} isIdleResource - Whether this is an idle resource recommendation
     * @returns {Array} Recommendation options array
     */
    static createRecommendationOptions(recommendedMachineType, costSavings, confidence, isIdleResource = false) {
        if (!recommendedMachineType || recommendedMachineType === 'STOP') {
            // For idle resources or missing recommendations
            return [{
                instanceType: isIdleResource ? 'STOP' : 'Current',
                projectedUtilizationMetrics: {
                    cpu: { maximum: isIdleResource ? 0 : null },
                    memory: { maximum: isIdleResource ? 0 : null }
                },
                platformDifferences: [],
                performanceRisk: isIdleResource ? 0.0 : 1.0,
                rank: 1,
                savingsOpportunity: {
                    estimatedMonthlySavings: {
                        value: costSavings.amount || 0,
                        currency: costSavings.currency || 'USD'
                    },
                    savingsOpportunityPercentage: isIdleResource ? 100.0 : 0.0
                }
            }];
        }

        // Calculate projected utilization based on recommendation type
        const projectedCpuMax = confidence > 0.8 ? 70.0 : 60.0; // Higher confidence = higher utilization target
        const projectedMemoryMax = confidence > 0.8 ? 80.0 : 70.0;

        return [{
            instanceType: recommendedMachineType,
            projectedUtilizationMetrics: {
                cpu: { maximum: projectedCpuMax },
                memory: { maximum: projectedMemoryMax }
            },
            platformDifferences: [],
            performanceRisk: confidence, // Use confidence as performance risk indicator
            rank: 1,
            savingsOpportunity: {
                estimatedMonthlySavings: {
                    value: costSavings.amount || 0,
                    currency: costSavings.currency || 'USD'
                },
                savingsOpportunityPercentage: costSavings.amount > 0 ?
                    Math.min(Math.round((costSavings.amount / 100) * 100), 50) : 0 // Cap at 50%
            }
        }];
    }

    /**
     * Generate human-readable recommendation text
     * Creates descriptive text based on finding type and savings
     * 
     * @param {string} finding - Finding type (Overprovisioned, Underprovisioned, Optimized)
     * @param {string} currentMachineType - Current machine type
     * @param {string} recommendedMachineType - Recommended machine type
     * @param {number} monthlySavings - Monthly cost savings
     * @param {boolean} isIdleResource - Whether this is an idle resource
     * @returns {string} Human-readable recommendation text
     */
    static generateRecommendationText(finding, currentMachineType, recommendedMachineType, monthlySavings, isIdleResource = false) {
        if (isIdleResource) {
            return `Instance appears to be idle. Consider stopping or deleting to save $${monthlySavings}/month.`;
        }

        if (!recommendedMachineType || recommendedMachineType === currentMachineType) {
            return 'Instance is optimally sized for current workload.';
        }

        const savingsText = monthlySavings > 0 ? ` and save $${monthlySavings}/month` : '';

        switch (finding) {
            case 'Overprovisioned':
                return `Downsize from ${currentMachineType} to ${recommendedMachineType} to reduce costs${savingsText}.`;

            case 'Underprovisioned':
                return `Upgrade from ${currentMachineType} to ${recommendedMachineType} to improve performance${savingsText}.`;

            default:
                return `Consider changing from ${currentMachineType} to ${recommendedMachineType}${savingsText}.`;
        }
    }

    /**
     * Transform a complete GCP recommendation to standard format
     * Main transformation method that combines all transformation functions
     * 
     * @param {Object} gcpRecommendation - GCP recommendation object
     * @param {Object} vmInstance - VM instance data
     * @param {Object} options - Additional options
     * @returns {Object} Transformed recommendation in standard format
     */
    static transformRecommendation(gcpRecommendation, vmInstance, options = {}) {
        const finding = this.transformRecommendationFinding(gcpRecommendation);
        const confidence = this.calculateConfidence(gcpRecommendation);
        const costSavings = this.extractCostSavings(gcpRecommendation);
        const recommendedMachineType = this.extractRecommendedMachineType(gcpRecommendation);

        // Determine if this is an idle resource recommendation
        const isIdleResource = gcpRecommendation.name &&
            gcpRecommendation.name.includes('IdleResourceRecommender');

        const currentMachineType = vmInstance.machineType?.split('/').pop() || vmInstance.machineType;

        // Generate recommendation options and text
        const recommendationOptions = this.createRecommendationOptions(
            recommendedMachineType,
            costSavings,
            confidence,
            isIdleResource
        );

        const recommendationText = this.generateRecommendationText(
            finding,
            currentMachineType,
            recommendedMachineType,
            costSavings.amount,
            isIdleResource
        );

        return {
            // Core identification
            instance_id: vmInstance.name,
            instance_name: vmInstance.name,
            provider: 'GCP',

            // Recommendation data
            compute_optimizer_finding: finding,
            recommendation: recommendationText,
            recommended_instance_type: recommendedMachineType,
            estimated_monthly_savings: costSavings.amount,

            // Confidence and metadata
            confidence: confidence,
            confidence_level: confidence >= 0.8 ? 'high' : confidence >= 0.6 ? 'medium' : 'low',

            // GCP-specific metadata
            gcp_recommendation_id: gcpRecommendation.name?.split('/').pop(),
            gcp_recommender_type: gcpRecommendation.name?.includes('MachineTypeRecommender') ?
                'google.compute.instance.MachineTypeRecommender' :
                'google.compute.instance.IdleResourceRecommender',
            priority: gcpRecommendation.priority,
            last_refresh_time: gcpRecommendation.lastRefreshTime,
            recommendation_subtype: gcpRecommendation.recommenderSubtype,

            // Frontend compatibility
            compute_optimizer_recommendation_options: recommendationOptions,
            finding_reasons: isIdleResource ? ['IDLE_RESOURCE'] : []
        };
    }
}

/**
 * Initialize GCP Recommender client with proper error handling
 * @param {Object} credentialsObj - GCP service account credentials
 * @returns {RecommenderClient} Initialized recommender client
 */
const initializeGCPRecommenderClient = (credentialsObj) => {
    try {
        logger.info('[GCP Recommender] Initializing Recommender API client');

        if (!credentialsObj) {
            throw new Error('Missing GCP credentials object');
        }

        if (!credentialsObj.project_id) {
            throw new Error('Missing project_id in GCP credentials');
        }

        const recommenderClient = new RecommenderClient({
            credentials: credentialsObj,
            // Add timeout configuration
            timeout: 30000, // 30 seconds
        });

        logger.info('[GCP Recommender] ✓ Recommender client initialized successfully');
        return recommenderClient;
    } catch (error) {
        logger.error(`[GCP Recommender] ❌ Failed to initialize Recommender client: ${error.message}`);
        throw new GCPRecommenderError('Failed to initialize GCP Recommender client', error);
    }
};

/**
 * Custom error class for GCP Recommender API operations
 */
class GCPRecommenderError extends Error {
    constructor(message, originalError = null, errorCode = null) {
        super(message);
        this.name = 'GCPRecommenderError';
        this.originalError = originalError;
        this.errorCode = errorCode;
        this.timestamp = new Date().toISOString();

        // Capture stack trace
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, GCPRecommenderError);
        }
    }

    toJSON() {
        return {
            name: this.name,
            message: this.message,
            errorCode: this.errorCode,
            timestamp: this.timestamp,
            originalError: this.originalError ? {
                message: this.originalError.message,
                code: this.originalError.code,
                status: this.originalError.status
            } : null
        };
    }
}

/**
 * Classify GCP API errors for appropriate handling
 * @param {Error} error - Original error from GCP API
 * @returns {Object} Error classification with handling strategy
 */
const classifyGCPRecommenderError = (error) => {
    const classification = {
        type: 'unknown',
        severity: 'error',
        retryable: false,
        userMessage: 'An unexpected error occurred',
        logLevel: 'error'
    };

    if (!error) return classification;

    const errorCode = error.code || error.status;
    const errorMessage = error.message || '';

    // Permission denied errors
    if (errorCode === 7 || errorMessage.includes('PERMISSION_DENIED')) {
        classification.type = 'permission_denied';
        classification.severity = 'warning';
        classification.retryable = false;
        classification.userMessage = 'Missing permissions for GCP Recommender API';
        classification.logLevel = 'warn';
    }
    // API not enabled
    else if (errorCode === 3 || errorMessage.includes('INVALID_ARGUMENT') ||
        errorMessage.includes('API not enabled')) {
        classification.type = 'api_not_enabled';
        classification.severity = 'warning';
        classification.retryable = false;
        classification.userMessage = 'GCP Recommender API is not enabled for this project';
        classification.logLevel = 'warn';
    }
    // Rate limiting
    else if (errorCode === 8 || errorMessage.includes('RESOURCE_EXHAUSTED') ||
        errorMessage.includes('quota exceeded')) {
        classification.type = 'rate_limited';
        classification.severity = 'warning';
        classification.retryable = true;
        classification.userMessage = 'GCP API rate limit exceeded, will retry';
        classification.logLevel = 'warn';
    }
    // Timeout errors
    else if (errorCode === 4 || errorMessage.includes('DEADLINE_EXCEEDED') ||
        errorMessage.includes('timeout')) {
        classification.type = 'timeout';
        classification.severity = 'warning';
        classification.retryable = true;
        classification.userMessage = 'GCP API request timed out, will retry';
        classification.logLevel = 'warn';
    }
    // Service unavailable
    else if (errorCode === 14 || errorMessage.includes('UNAVAILABLE')) {
        classification.type = 'service_unavailable';
        classification.severity = 'warning';
        classification.retryable = true;
        classification.userMessage = 'GCP service temporarily unavailable, will retry';
        classification.logLevel = 'warn';
    }
    // Authentication errors
    else if (errorCode === 16 || errorMessage.includes('UNAUTHENTICATED')) {
        classification.type = 'authentication_failed';
        classification.severity = 'error';
        classification.retryable = false;
        classification.userMessage = 'GCP authentication failed';
        classification.logLevel = 'error';
    }

    return classification;
};

/**
 * Enhanced logging for GCP Recommender operations
 * Provides structured logging with context and error classification
 */
class GCPRecommenderLogger {
    static logOperationStart(operation, context = {}) {
        logger.info(`[GCP Recommender] Starting ${operation}`, {
            operation,
            context,
            timestamp: new Date().toISOString()
        });
    }

    static logOperationSuccess(operation, result = {}, duration = null) {
        const message = `[GCP Recommender] ✓ ${operation} completed successfully`;
        const logData = {
            operation,
            result: typeof result === 'object' ? result : { value: result },
            timestamp: new Date().toISOString()
        };

        if (duration !== null) {
            logData.durationMs = duration;
        }

        logger.info(message, logData);
    }

    static logOperationError(operation, error, context = {}) {
        const classification = classifyGCPRecommenderError(error);
        const message = `[GCP Recommender] ${classification.severity === 'error' ? '❌' : '⚠️'} ${operation} failed: ${error.message}`;

        const logData = {
            operation,
            error: {
                message: error.message,
                code: error.code,
                type: classification.type,
                severity: classification.severity,
                retryable: classification.retryable
            },
            context,
            timestamp: new Date().toISOString()
        };

        if (classification.logLevel === 'error') {
            logger.error(message, logData);
        } else {
            logger.warn(message, logData);
        }

        return classification;
    }

    static logRecommendationSummary(projectId, zone, recommenderType, count, processingTime) {
        logger.info(`[GCP Recommender] Recommendation summary`, {
            projectId,
            zone,
            recommenderType,
            recommendationCount: count,
            processingTimeMs: processingTime,
            timestamp: new Date().toISOString()
        });
    }

    static logAPIQuotaUsage(operation, quotaUsed, quotaLimit = null) {
        const message = `[GCP Recommender] API quota usage for ${operation}`;
        const logData = {
            operation,
            quotaUsed,
            quotaLimit,
            utilizationPercent: quotaLimit ? Math.round((quotaUsed / quotaLimit) * 100) : null,
            timestamp: new Date().toISOString()
        };

        if (quotaLimit && (quotaUsed / quotaLimit) > 0.8) {
            logger.warn(`${message} - High quota utilization`, logData);
        } else {
            logger.info(message, logData);
        }
    }
}

/**
 * Retry mechanism for GCP Recommender API calls
 * Implements exponential backoff with jitter and quota-aware delays
 */
const retryGCPRecommenderOperation = async (operation, maxRetries = 3, baseDelay = 5000) => {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const startTime = Date.now();
            const result = await operation();
            const duration = Date.now() - startTime;

            // Record success for circuit breaker
            gcpQuotaTracker.recordSuccess();

            if (attempt > 1) {
                logger.info(`[GCP Recommender] ✓ Operation succeeded on attempt ${attempt} after ${duration}ms`);
            }

            return result;
        } catch (error) {
            lastError = error;
            const classification = classifyGCPRecommenderError(error);

            // Record failure for circuit breaker
            gcpQuotaTracker.recordFailure(error);

            // Don't retry non-retryable errors or if circuit breaker is open
            if (!classification.retryable || attempt === maxRetries || gcpQuotaTracker.isCircuitOpen()) {
                GCPRecommenderLogger.logOperationError('Retry operation', error, {
                    attempt,
                    maxRetries,
                    finalAttempt: true,
                    circuitBreakerOpen: gcpQuotaTracker.isCircuitOpen()
                });
                throw error;
            }

            // Calculate delay with exponential backoff and jitter
            // For quota exhaustion, use longer delays
            let delay = baseDelay * Math.pow(2, attempt - 1);

            // Special handling for quota exhaustion - much longer delays
            if (classification.type === 'rate_limited') {
                delay = Math.max(delay, 30000 * attempt); // Minimum 30s, 60s, 90s for quota issues
                logger.warn(`[GCP Recommender] ⚠️ Quota exhausted - using extended delay: ${delay}ms`);
            }

            const jitter = Math.random() * 0.1 * delay; // 10% jitter
            const totalDelay = Math.floor(delay + jitter);

            logger.warn(`[GCP Recommender] ⚠️ Attempt ${attempt} failed, retrying in ${totalDelay}ms: ${error.message}`);

            await new Promise(resolve => setTimeout(resolve, totalDelay));
        }
    }

    throw lastError;
};

/**
 * Validate GCP Recommender API response
 * Ensures response structure matches expected format
 */
const validateGCPRecommenderResponse = (response, expectedType = 'recommendations') => {
    if (!response) {
        throw new GCPRecommenderError('Empty response from GCP Recommender API');
    }

    if (expectedType === 'recommendations') {
        if (!Array.isArray(response)) {
            throw new GCPRecommenderError('Invalid response format: expected array of recommendations');
        }

        // Validate each recommendation has required fields
        response.forEach((rec, index) => {
            if (!rec.name) {
                throw new GCPRecommenderError(`Recommendation ${index} missing required 'name' field`);
            }
            if (!rec.content) {
                throw new GCPRecommenderError(`Recommendation ${index} missing required 'content' field`);
            }
        });
    }

    return true;
};

/**
 * Test GCP Recommender API connectivity and permissions
 * @param {Object} credentialsObj - GCP service account credentials
 * @param {string} projectId - GCP project ID
 * @returns {Object} Connection test results
 */
const testGCPRecommenderConnection = async (credentialsObj, projectId) => {
    const testResults = {
        success: false,
        machineTypeRecommender: false,
        idleResourceRecommender: false,
        errors: [],
        permissions: {
            missing: [],
            available: []
        }
    };

    try {
        GCPRecommenderLogger.logOperationStart('GCP Recommender connection test', { projectId });

        const recommenderClient = initializeGCPRecommenderClient(credentialsObj);

        // Test Machine Type Recommender access
        try {
            const machineTypeParent = `projects/${projectId}/locations/global/recommenders/google.compute.instance.MachineTypeRecommender`;

            await retryGCPRecommenderOperation(async () => {
                const [recommendations] = await recommenderClient.listRecommendations({
                    parent: machineTypeParent,
                    pageSize: 1 // Just test access, don't fetch all
                });
                return recommendations;
            });

            testResults.machineTypeRecommender = true;
            testResults.permissions.available.push('Machine Type Recommender');
            logger.info('[GCP Recommender] ✓ Machine Type Recommender API accessible');

        } catch (error) {
            const classification = GCPRecommenderLogger.logOperationError('Machine Type Recommender test', error);
            testResults.errors.push({
                api: 'MachineTypeRecommender',
                error: classification.userMessage,
                code: error.code
            });

            if (classification.type === 'permission_denied') {
                testResults.permissions.missing.push('recommender.computeInstanceMachineTypeRecommendations.list');
            }
        }

        // Test Idle Resource Recommender access
        try {
            const idleResourceParent = `projects/${projectId}/locations/global/recommenders/google.compute.instance.IdleResourceRecommender`;

            await retryGCPRecommenderOperation(async () => {
                const [recommendations] = await recommenderClient.listRecommendations({
                    parent: idleResourceParent,
                    pageSize: 1 // Just test access, don't fetch all
                });
                return recommendations;
            });

            testResults.idleResourceRecommender = true;
            testResults.permissions.available.push('Idle Resource Recommender');
            logger.info('[GCP Recommender] ✓ Idle Resource Recommender API accessible');

        } catch (error) {
            const classification = GCPRecommenderLogger.logOperationError('Idle Resource Recommender test', error);
            testResults.errors.push({
                api: 'IdleResourceRecommender',
                error: classification.userMessage,
                code: error.code
            });

            if (classification.type === 'permission_denied') {
                testResults.permissions.missing.push('recommender.computeInstanceIdleResourceRecommendations.list');
            }
        }

        // Overall success if at least one recommender is accessible
        testResults.success = testResults.machineTypeRecommender || testResults.idleResourceRecommender;

        if (testResults.success) {
            GCPRecommenderLogger.logOperationSuccess('GCP Recommender connection test', {
                machineTypeRecommender: testResults.machineTypeRecommender,
                idleResourceRecommender: testResults.idleResourceRecommender,
                availablePermissions: testResults.permissions.available.length,
                missingPermissions: testResults.permissions.missing.length
            });
        } else {
            logger.warn('[GCP Recommender] ⚠️ No Recommender APIs accessible - recommendations will not be available');
        }

        return testResults;

    } catch (error) {
        GCPRecommenderLogger.logOperationError('GCP Recommender connection test', error);
        testResults.errors.push({
            api: 'General',
            error: error.message,
            code: error.code
        });
        return testResults;
    }
};

/**
 * Fetch machine type recommendations from GCP Recommender API for a specific zone
 * Implements proper parent path construction and pagination handling
 * 
 * @param {RecommenderClient} recommenderClient - Initialized GCP Recommender client
 * @param {string} projectId - GCP project ID
 * @param {string} zone - GCP zone (e.g., 'us-central1-a')
 * @param {Object} options - Optional parameters
 * @param {number} options.pageSize - Maximum recommendations per page (default: 100)
 * @param {string} options.filter - Additional filter criteria (default: 'stateInfo.state=ACTIVE')
 * @returns {Promise<Array>} Array of machine type recommendations
 */
const fetchMachineTypeRecommendations = async (recommenderClient, projectId, zone, options = {}) => {
    // Check circuit breaker before making any API calls
    if (gcpQuotaTracker.isCircuitOpen()) {
        logger.warn(`[GCP Recommender] Circuit breaker OPEN - skipping machine type recommendations for zone ${zone}`);
        return [];
    }

    const {
        pageSize = 100,
        filter = 'stateInfo.state=ACTIVE'
    } = options;

    // Construct parent path for Machine Type Recommender
    const parent = `projects/${projectId}/locations/${zone}/recommenders/google.compute.instance.MachineTypeRecommender`;

    GCPRecommenderLogger.logOperationStart('Fetch Machine Type Recommendations', {
        projectId,
        zone,
        parent,
        pageSize,
        filter
    });

    const startTime = Date.now();
    let allRecommendations = [];
    let pageToken = null;
    let pageCount = 0;

    try {
        do {
            pageCount++;
            const requestParams = {
                parent,
                filter,
                pageSize
            };

            // Add page token for pagination
            if (pageToken) {
                requestParams.pageToken = pageToken;
            }

            logger.info(`[GCP Recommender] Fetching machine type recommendations page ${pageCount} for zone ${zone}`);

            // Use retry logic for API call
            const [recommendations, , response] = await retryGCPRecommenderOperation(async () => {
                return await recommenderClient.listRecommendations(requestParams);
            });

            // Validate response format
            validateGCPRecommenderResponse(recommendations, 'recommendations');

            // Add recommendations to collection
            if (recommendations && recommendations.length > 0) {
                allRecommendations.push(...recommendations);
                logger.info(`[GCP Recommender] Found ${recommendations.length} machine type recommendations on page ${pageCount} for zone ${zone}`);
            }

            // Check for next page
            pageToken = response?.nextPageToken || null;

            // Safety check to prevent infinite loops
            if (pageCount > 50) {
                logger.warn(`[GCP Recommender] Stopping pagination after 50 pages for zone ${zone} - potential infinite loop`);
                break;
            }

        } while (pageToken);

        const processingTime = Date.now() - startTime;

        GCPRecommenderLogger.logRecommendationSummary(
            projectId,
            zone,
            'MachineType',
            allRecommendations.length,
            processingTime
        );

        logger.info(`[GCP Recommender] Successfully fetched ${allRecommendations.length} machine type recommendations for zone ${zone} in ${processingTime}ms`);

        return allRecommendations;

    } catch (error) {
        const processingTime = Date.now() - startTime;

        GCPRecommenderLogger.logOperationError('Fetch Machine Type Recommendations', error, {
            projectId,
            zone,
            pageCount,
            processingTime
        });

        // Handle specific GCP errors gracefully
        const classification = classifyGCPRecommenderError(error);

        if (classification.type === 'permission_denied') {
            logger.warn(`[GCP Recommender] Missing permissions for Machine Type Recommender in zone ${zone} - continuing without recommendations`);
            return [];
        }

        if (classification.type === 'api_not_enabled') {
            logger.warn(`[GCP Recommender] Machine Type Recommender API not enabled for project in zone ${zone} - continuing without recommendations`);
            return [];
        }

        if (classification.type === 'resource_not_found') {
            logger.warn(`[GCP Recommender] Machine Type Recommender not available in zone ${zone} - continuing without recommendations`);
            return [];
        }

        // For other errors, log and re-throw to allow caller to handle
        logger.error(`[GCP Recommender] Failed to fetch machine type recommendations for zone ${zone}: ${error.message}`);
        throw error;
    }
};

/**
 * Fetch idle resource recommendations from GCP Recommender API for a specific zone
 * Implements proper parent path construction, timeout handling, and error handling for API not enabled scenarios
 * 
 * @param {RecommenderClient} recommenderClient - Initialized GCP Recommender client
 * @param {string} projectId - GCP project ID
 * @param {string} zone - GCP zone (e.g., 'us-central1-a')
 * @param {Object} options - Optional parameters
 * @param {number} options.pageSize - Maximum recommendations per page (default: 100)
 * @param {string} options.filter - Additional filter criteria (default: 'stateInfo.state=ACTIVE')
 * @param {number} options.timeoutMs - Timeout in milliseconds (default: 30000)
 * @returns {Promise<Array>} Array of idle resource recommendations
 */
const fetchIdleResourceRecommendations = async (recommenderClient, projectId, zone, options = {}) => {
    // Check circuit breaker before making any API calls
    if (gcpQuotaTracker.isCircuitOpen()) {
        logger.warn(`[GCP Recommender] Circuit breaker OPEN - skipping idle resource recommendations for zone ${zone}`);
        return [];
    }

    const {
        pageSize = 100,
        filter = 'stateInfo.state=ACTIVE',
        timeoutMs = 30000 // 30-second timeout as per requirements
    } = options;

    // Construct parent path for Idle Resource Recommender
    const parent = `projects/${projectId}/locations/${zone}/recommenders/google.compute.instance.IdleResourceRecommender`;

    GCPRecommenderLogger.logOperationStart('Fetch Idle Resource Recommendations', {
        projectId,
        zone,
        parent,
        pageSize,
        filter,
        timeoutMs
    });

    const startTime = Date.now();
    let allRecommendations = [];
    let pageToken = null;
    let pageCount = 0;

    try {
        // Wrap the entire operation with timeout
        const fetchWithTimeout = async () => {
            do {
                pageCount++;
                const requestParams = {
                    parent,
                    filter,
                    pageSize
                };

                // Add page token for pagination
                if (pageToken) {
                    requestParams.pageToken = pageToken;
                }

                logger.info(`[GCP Recommender] Fetching idle resource recommendations page ${pageCount} for zone ${zone}`);

                // Use retry logic for API call
                const [recommendations, , response] = await retryGCPRecommenderOperation(async () => {
                    return await recommenderClient.listRecommendations(requestParams);
                });

                // Validate response format
                validateGCPRecommenderResponse(recommendations, 'recommendations');

                // Add recommendations to collection
                if (recommendations && recommendations.length > 0) {
                    allRecommendations.push(...recommendations);
                    logger.info(`[GCP Recommender] Found ${recommendations.length} idle resource recommendations on page ${pageCount} for zone ${zone}`);
                }

                // Check for next page
                pageToken = response?.nextPageToken || null;

                // Safety check to prevent infinite loops
                if (pageCount > 50) {
                    logger.warn(`[GCP Recommender] Stopping pagination after 50 pages for zone ${zone} - potential infinite loop`);
                    break;
                }

            } while (pageToken);

            return allRecommendations;
        };

        // Apply timeout handling
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Idle Resource Recommender API timeout after ${timeoutMs}ms for zone ${zone}`));
            }, timeoutMs);
        });

        allRecommendations = await Promise.race([fetchWithTimeout(), timeoutPromise]);

        const processingTime = Date.now() - startTime;

        GCPRecommenderLogger.logRecommendationSummary(
            projectId,
            zone,
            'IdleResource',
            allRecommendations.length,
            processingTime
        );

        logger.info(`[GCP Recommender] Successfully fetched ${allRecommendations.length} idle resource recommendations for zone ${zone} in ${processingTime}ms`);

        return allRecommendations;

    } catch (error) {
        const processingTime = Date.now() - startTime;

        GCPRecommenderLogger.logOperationError('Fetch Idle Resource Recommendations', error, {
            projectId,
            zone,
            pageCount,
            processingTime
        });

        // Handle specific GCP errors gracefully - API not enabled scenarios
        const classification = classifyGCPRecommenderError(error);

        if (classification.type === 'permission_denied') {
            logger.warn(`[GCP Recommender] Missing permissions for Idle Resource Recommender in zone ${zone} - continuing without recommendations`);
            return [];
        }

        if (classification.type === 'api_not_enabled') {
            logger.warn(`[GCP Recommender] Idle Resource Recommender API not enabled for project in zone ${zone} - this is normal for many projects`);
            return [];
        }

        if (classification.type === 'resource_not_found') {
            logger.warn(`[GCP Recommender] Idle Resource Recommender not available in zone ${zone} - this recommender may not be supported in all regions`);
            return [];
        }

        // Handle timeout errors specifically
        if (error.message.includes('timeout')) {
            logger.warn(`[GCP Recommender] Idle Resource Recommender API timed out for zone ${zone} after ${timeoutMs}ms - continuing without recommendations`);
            return [];
        }

        // For other errors, log and re-throw to allow caller to handle
        logger.error(`[GCP Recommender] Failed to fetch idle resource recommendations for zone ${zone}: ${error.message}`);
        throw error;
    }
};

/**
 * Calculate and enrich VM instances with cost data for current and recommended configurations
 * This function integrates with the existing VM fetching process
 * @param {Array} vmInstances - Array of VM instances from GCP Compute API
 * @param {string} projectId - GCP project ID
 * @param {Array} recommendations - Optional array of GCP recommendations
 * @param {Object} options - Configuration options
 * @returns {Array} VM instances enriched with cost data
 */
const enrichVMsWithGCPCosts = async (vmInstances, projectId, recommendations = [], options = {}) => {
    const {
        hoursPerMonth = 730,
        enableCaching = true,
        batchSize = 10
    } = options;

    logger.info(`[GCP Cost Enrichment] Starting cost enrichment for ${vmInstances.length} VMs`);

    try {
        // Initialize cost calculator
        const costCalculator = new GCPCostCalculator(projectId);

        // Enrich VMs with cost data
        const enrichedVMs = await costCalculator.enrichVMsWithCosts(
            vmInstances,
            recommendations,
            hoursPerMonth
        );

        // Calculate total savings summary
        const savingsSummary = costCalculator.calculateTotalSavings(enrichedVMs);

        logger.info(`[GCP Cost Enrichment] Cost enrichment completed: ${savingsSummary.vms_with_recommendations} VMs with recommendations, $${savingsSummary.total_monthly_savings.toFixed(2)}/mo potential savings`);

        return {
            vms: enrichedVMs,
            summary: savingsSummary,
            enrichment_timestamp: new Date().toISOString()
        };

    } catch (error) {
        logger.error(`[GCP Cost Enrichment] Failed to enrich VMs with costs: ${error.message}`);

        // Return VMs with basic cost data as fallback
        const fallbackVMs = vmInstances.map(vm => {
            const costCalculator = new GCPCostCalculator(projectId);
            return {
                ...vm,
                ...costCalculator.getDefaultCostBreakdown(),
                has_recommendation: false,
                cost_calculated_at: new Date().toISOString()
            };
        });

        return {
            vms: fallbackVMs,
            summary: {
                total_vms: vmInstances.length,
                vms_with_recommendations: 0,
                vms_optimized: vmInstances.length,
                vms_overprovisioned: 0,
                vms_underprovisioned: 0,
                total_current_monthly_cost: 0,
                total_recommended_monthly_cost: 0,
                total_monthly_savings: 0,
                average_savings_percentage: 0,
                currency: 'USD'
            },
            enrichment_timestamp: new Date().toISOString()
        };
    }
};

/**
 * Calculate monthly cost from hourly rate using standard 730-hour calculation
 * @param {number} hourlyRate - Hourly rate in USD
 * @param {number} hoursPerMonth - Hours per month (default: 730)
 * @returns {number} Monthly cost
 */
const calculateMonthlyCost = (hourlyRate, hoursPerMonth = 730) => {
    if (typeof hourlyRate !== 'number' || hourlyRate < 0) {
        logger.warn(`[GCP Cost Calculation] Invalid hourly rate: ${hourlyRate}`);
        return 0;
    }

    return Math.round((hourlyRate * hoursPerMonth) * 100) / 100; // Round to 2 decimal places
};

/**
 * Calculate savings percentage with proper division by zero handling
 * @param {number} currentCost - Current monthly cost
 * @param {number} recommendedCost - Recommended monthly cost
 * @returns {number} Savings percentage (0-100)
 */
const calculateSavingsPercentage = (currentCost, recommendedCost) => {
    if (typeof currentCost !== 'number' || typeof recommendedCost !== 'number') {
        logger.warn(`[GCP Cost Calculation] Invalid cost values: current=${currentCost}, recommended=${recommendedCost}`);
        return 0;
    }

    if (currentCost <= 0) {
        logger.debug(`[GCP Cost Calculation] Current cost is zero or negative: ${currentCost}`);
        return 0;
    }

    const savings = currentCost - recommendedCost;
    const percentage = (savings / currentCost) * 100;

    // Ensure percentage is between 0 and 100, and round to 1 decimal place
    return Math.max(0, Math.min(100, Math.round(percentage * 10) / 10));
};

/**
 * Validate and normalize cost data for VM instances
 * @param {Object} costData - Cost data object
 * @returns {Object} Validated and normalized cost data
 */
const validateCostData = (costData) => {
    const defaults = {
        current_hourly_rate: 0,
        current_monthly_cost: 0,
        recommended_hourly_rate: 0,
        recommended_monthly_cost: 0,
        estimated_monthly_savings: 0,
        savings_percentage: 0,
        currency: 'USD',
        cost_source: 'unknown'
    };

    try {
        const validated = { ...defaults };

        // Validate numeric fields
        const numericFields = [
            'current_hourly_rate',
            'current_monthly_cost',
            'recommended_hourly_rate',
            'recommended_monthly_cost',
            'estimated_monthly_savings',
            'savings_percentage'
        ];

        for (const field of numericFields) {
            if (typeof costData[field] === 'number' && !isNaN(costData[field])) {
                validated[field] = Math.max(0, costData[field]); // Ensure non-negative
            }
        }

        // Validate string fields
        if (typeof costData.currency === 'string' && costData.currency.length === 3) {
            validated.currency = costData.currency.toUpperCase();
        }

        if (typeof costData.cost_source === 'string') {
            validated.cost_source = costData.cost_source;
        }

        // Recalculate monthly costs to ensure consistency
        validated.current_monthly_cost = calculateMonthlyCost(validated.current_hourly_rate);
        validated.recommended_monthly_cost = calculateMonthlyCost(validated.recommended_hourly_rate);
        validated.estimated_monthly_savings = Math.max(0,
            validated.current_monthly_cost - validated.recommended_monthly_cost
        );
        validated.savings_percentage = calculateSavingsPercentage(
            validated.current_monthly_cost,
            validated.recommended_monthly_cost
        );

        return validated;

    } catch (error) {
        logger.error(`[GCP Cost Validation] Failed to validate cost data: ${error.message}`);
        return defaults;
    }
};

/**
 * GCP Cost Calculator Class
 * Provides cost calculation functionality with caching and region-specific pricing
 * Integrates with existing estimateGCPCost() function for consistency
 */
class GCPCostCalculator {
    constructor(projectId, credentials = null) {
        this.projectId = projectId;
        this.credentials = credentials;
        this.pricingCache = new Map();
        this.cacheTimeout = 24 * 60 * 60 * 1000; // 24 hours TTL

        logger.info(`[GCP Cost Calculator] Initialized for project ${projectId}`);
    }

    /**
     * Calculate instance cost with caching support
     * @param {string} machineType - GCP machine type (e.g., 'n1-standard-2')
     * @param {string} zone - GCP zone (e.g., 'us-central1-a')
     * @param {number} hoursPerMonth - Hours per month (default: 730)
     * @returns {Object} Cost breakdown with hourly and monthly rates
     */
    /**
         * Calculate instance cost with caching support and GCP Recommender fallback
         * @param {string} machineType - GCP machine type (e.g., 'n1-standard-2')
         * @param {string} zone - GCP zone (e.g., 'us-central1-a')
         * @param {number} hoursPerMonth - Hours per month (default: 730)
         * @param {Object} gcpRecommendation - Optional GCP recommendation for fallback cost projection
         * @returns {Object} Cost breakdown with hourly and monthly rates
         */
    async calculateInstanceCost(machineType, zone, hoursPerMonth = 730, gcpRecommendation = null) {
        try {
            // Generate cache key
            const cacheKey = `${machineType}-${zone}`;

            // Check cache first
            const cachedCost = this.getCachedCost(cacheKey);
            if (cachedCost) {
                logger.debug(`[GCP Cost Calculator] Using cached cost for ${machineType} in ${zone}`);
                return {
                    hourly: cachedCost.hourly,
                    monthly: cachedCost.hourly * hoursPerMonth,
                    currency: cachedCost.currency,
                    region: cachedCost.region,
                    isEstimated: cachedCost.isEstimated,
                    source: 'cache'
                };
            }

            // Try primary pricing method: existing estimateGCPCost function
            let costData = null;
            let pricingError = null;

            try {
                costData = estimateGCPCost(machineType, zone);
                logger.debug(`[GCP Cost Calculator] Primary pricing successful for ${machineType} in ${zone}: ${costData.hourly}/hour`);
            } catch (primaryError) {
                pricingError = primaryError;
                logger.warn(`[GCP Cost Calculator] Primary pricing failed for ${machineType} in ${zone}: ${primaryError.message}`);
            }

            // If primary pricing failed and we have a GCP recommendation, use cost projection fallback
            if (!costData && gcpRecommendation) {
                logger.info(`[GCP Cost Calculator] Attempting cost projection fallback for ${machineType} in ${zone}`);
                costData = this.extractCostFromRecommendation(gcpRecommendation, machineType, zone, hoursPerMonth);

                if (costData) {
                    logger.info(`[GCP Cost Calculator] ✓ Cost projection fallback successful for ${machineType}: ${costData.hourly}/hour`);
                } else {
                    logger.warn(`[GCP Cost Calculator] ✗ Cost projection fallback failed for ${machineType}`);
                }
            }

            // If we have cost data from either method, cache and return it
            if (costData) {
                // Cache the result
                this.setCachedCost(cacheKey, costData);

                return {
                    hourly: costData.hourly,
                    monthly: costData.hourly * hoursPerMonth,
                    currency: costData.currency,
                    region: costData.region,
                    isEstimated: costData.isEstimated,
                    source: costData.source || 'calculated'
                };
            }

            // If all pricing methods failed, throw the original error
            throw pricingError || new Error('All pricing methods failed');

        } catch (error) {
            logger.error(`[GCP Cost Calculator] All pricing methods failed for ${machineType} in ${zone}: ${error.message}`);

            // Return generic fallback cost as last resort
            return {
                hourly: 0.05,
                monthly: 0.05 * hoursPerMonth,
                currency: 'USD',
                region: zone ? zone.split('-').slice(0, -1).join('-') : 'us-central1',
                isEstimated: true,
                source: 'generic_fallback'
            };
        }
    }

    /**
     * Get hourly rate for a machine type in a specific zone
     * @param {string} machineType - GCP machine type
     * @param {string} zone - GCP zone
     * @returns {number} Hourly rate in USD
     */
    async getHourlyRate(machineType, zone) {
        const costData = await this.calculateInstanceCost(machineType, zone, 1);
        return costData.hourly;
    }

    /**
     * Calculate cost savings between current and recommended instance types
     * @param {string} currentMachineType - Current machine type
     * @param {string} recommendedMachineType - Recommended machine type
     * @param {string} zone - GCP zone
     * @param {number} hoursPerMonth - Hours per month (default: 730)
     * @returns {Object} Savings calculation with amounts and percentages
     */
    /**
         * Calculate cost savings between current and recommended instance types with fallback support
         * @param {string} currentMachineType - Current machine type
         * @param {string} recommendedMachineType - Recommended machine type
         * @param {string} zone - GCP zone
         * @param {number} hoursPerMonth - Hours per month (default: 730)
         * @param {Object} gcpRecommendation - Optional GCP recommendation for fallback cost projection
         * @returns {Object} Savings calculation with amounts and percentages
         */
    async calculateSavings(currentMachineType, recommendedMachineType, zone, hoursPerMonth = 730, gcpRecommendation = null) {
        try {
            // Handle idle resource recommendations (STOP)
            if (recommendedMachineType === 'STOP' || recommendedMachineType === 'DELETE') {
                const currentCost = await this.calculateInstanceCost(currentMachineType, zone, hoursPerMonth, gcpRecommendation);
                return {
                    currentMonthlyCost: currentCost.monthly,
                    recommendedMonthlyCost: 0,
                    monthlySavings: currentCost.monthly,
                    savingsPercentage: 100,
                    currency: currentCost.currency,
                    isIdleRecommendation: true,
                    costSource: currentCost.source
                };
            }

            // Calculate costs for both machine types with fallback support
            const [currentCost, recommendedCost] = await Promise.all([
                this.calculateInstanceCost(currentMachineType, zone, hoursPerMonth, gcpRecommendation),
                this.calculateInstanceCost(recommendedMachineType, zone, hoursPerMonth, gcpRecommendation)
            ]);

            const monthlySavings = currentCost.monthly - recommendedCost.monthly;
            const savingsPercentage = currentCost.monthly > 0 ?
                (monthlySavings / currentCost.monthly) * 100 : 0;

            // Determine if fallback was used
            const usedFallback = currentCost.source?.includes('fallback') || recommendedCost.source?.includes('fallback');

            logger.debug(`[GCP Cost Calculator] Savings calculation: ${currentMachineType} (${currentCost.monthly}) -> ${recommendedMachineType} (${recommendedCost.monthly}) = ${monthlySavings} (${savingsPercentage.toFixed(1)}%)${usedFallback ? ' [fallback used]' : ''}`);

            return {
                currentMonthlyCost: currentCost.monthly,
                recommendedMonthlyCost: recommendedCost.monthly,
                monthlySavings: monthlySavings,
                savingsPercentage: Math.round(savingsPercentage * 10) / 10, // Round to 1 decimal
                currency: currentCost.currency,
                isIdleRecommendation: false,
                costSource: usedFallback ? 'fallback' : 'standard',
                currentCostSource: currentCost.source,
                recommendedCostSource: recommendedCost.source
            };

        } catch (error) {
            logger.error(`[GCP Cost Calculator] Failed to calculate savings: ${error.message}`);
            return {
                currentMonthlyCost: 0,
                recommendedMonthlyCost: 0,
                monthlySavings: 0,
                savingsPercentage: 0,
                currency: 'USD',
                isIdleRecommendation: false,
                costSource: 'error'
            };
        }
    }

    /**
     * Apply region-specific pricing multipliers
     * @param {number} baseCost - Base cost before regional adjustment
     * @param {string} zone - GCP zone
     * @returns {number} Adjusted cost with regional multiplier
     */
    applyRegionalMultiplier(baseCost, zone) {
        // Extract region from zone
        const region = zone ? zone.split('-').slice(0, -1).join('-') : 'us-central1';

        // Use the same regional multipliers as estimateGCPCost
        const regionMultipliers = {
            // US regions
            'us-central1': 1.0,
            'us-east1': 1.0,
            'us-east4': 1.0,
            'us-west1': 1.0,
            'us-west2': 1.04,
            'us-west3': 1.04,
            'us-west4': 1.04,

            // Europe regions
            'europe-west1': 1.05,
            'europe-west2': 1.10,
            'europe-west3': 1.10,
            'europe-west4': 1.05,
            'europe-west6': 1.15,
            'europe-north1': 1.05,
            'europe-central2': 1.10,

            // Asia Pacific regions
            'asia-east1': 1.08,
            'asia-east2': 1.12,
            'asia-northeast1': 1.08,
            'asia-northeast2': 1.12,
            'asia-northeast3': 1.08,
            'asia-south1': 1.08,
            'asia-south2': 1.12,
            'asia-southeast1': 1.10,
            'asia-southeast2': 1.15,

            // Other regions
            'australia-southeast1': 1.12,
            'australia-southeast2': 1.15,
            'southamerica-east1': 1.20,
            'northamerica-northeast1': 1.05,
            'northamerica-northeast2': 1.10
        };

        const multiplier = regionMultipliers[region] || 1.0;
        return baseCost * multiplier;
    }

    /**
     * Get cached cost data
     * @param {string} cacheKey - Cache key
     * @returns {Object|null} Cached cost data or null if expired/missing
     */
    getCachedCost(cacheKey) {
        const cached = this.pricingCache.get(cacheKey);
        if (!cached) {
            return null;
        }

        // Check if cache has expired
        if (Date.now() > cached.expiry) {
            this.pricingCache.delete(cacheKey);
            logger.debug(`[GCP Cost Calculator] Cache expired for ${cacheKey}`);
            return null;
        }

        return cached.data;
    }

    /**
     * Set cached cost data with TTL
     * @param {string} cacheKey - Cache key
     * @param {Object} costData - Cost data to cache
     */
    setCachedCost(cacheKey, costData) {
        this.pricingCache.set(cacheKey, {
            data: costData,
            expiry: Date.now() + this.cacheTimeout
        });

        logger.debug(`[GCP Cost Calculator] Cached cost for ${cacheKey} (TTL: 24h)`);
    }

    /**
     * Clear expired cache entries
     */
    cleanupCache() {
        const now = Date.now();
        let cleanedCount = 0;

        for (const [key, value] of this.pricingCache.entries()) {
            if (now > value.expiry) {
                this.pricingCache.delete(key);
                cleanedCount++;
            }
        }

        if (cleanedCount > 0) {
            logger.info(`[GCP Cost Calculator] Cleaned up ${cleanedCount} expired cache entries`);
        }
    }

    /**
     * Extract cost data from GCP Recommender API cost projection (fallback mechanism)
     * Used when standard pricing data is unavailable
     * @param {Object} gcpRecommendation - GCP recommendation object with cost projection
     * @param {string} machineType - Machine type for logging purposes
     * @param {string} zone - Zone for regional pricing
     * @param {number} hoursPerMonth - Hours per month for calculation
     * @returns {Object|null} Cost data extracted from recommendation or null if unavailable
     */
    extractCostFromRecommendation(gcpRecommendation, machineType, zone, hoursPerMonth = 730) {
        try {
            logger.debug(`[GCP Cost Calculator] Extracting cost from recommendation for ${machineType} in ${zone}`);

            // Validate input
            if (!gcpRecommendation) {
                logger.debug(`[GCP Cost Calculator] No recommendation provided for cost extraction`);
                return null;
            }

            // Check for primaryImpact with cost projection
            if (!gcpRecommendation.primaryImpact ||
                gcpRecommendation.primaryImpact.category !== 'COST' ||
                !gcpRecommendation.primaryImpact.costProjection) {
                logger.debug(`[GCP Cost Calculator] No cost projection found in recommendation`);
                return null;
            }

            const costProjection = gcpRecommendation.primaryImpact.costProjection;
            const cost = costProjection.cost;

            if (!cost || !cost.units) {
                logger.debug(`[GCP Cost Calculator] No cost units found in cost projection`);
                return null;
            }

            // Extract cost amount and currency
            const costAmount = parseFloat(cost.units) || 0;
            const currency = cost.currencyCode || 'USD';

            if (costAmount <= 0) {
                logger.debug(`[GCP Cost Calculator] Invalid cost amount: ${costAmount}`);
                return null;
            }

            // Convert to monthly cost based on duration
            let monthlyCost = costAmount;

            if (costProjection.duration) {
                const duration = costProjection.duration;
                logger.debug(`[GCP Cost Calculator] Cost projection duration: ${duration}`);

                // Parse duration string (e.g., "2592000s" for 30 days)
                if (duration.includes('s')) {
                    const seconds = parseInt(duration.replace('s', ''));
                    const days = seconds / (24 * 60 * 60);

                    if (days >= 365) {
                        // Annual to monthly
                        monthlyCost = costAmount / 12;
                        logger.debug(`[GCP Cost Calculator] Converted annual cost to monthly: ${costAmount} -> ${monthlyCost}`);
                    } else if (days >= 30) {
                        // Already monthly or close to it
                        monthlyCost = costAmount;
                        logger.debug(`[GCP Cost Calculator] Using monthly cost as-is: ${monthlyCost}`);
                    } else if (days >= 7) {
                        // Weekly to monthly
                        monthlyCost = costAmount * (30 / 7);
                        logger.debug(`[GCP Cost Calculator] Converted weekly cost to monthly: ${costAmount} -> ${monthlyCost}`);
                    } else {
                        // Daily to monthly
                        monthlyCost = costAmount * 30;
                        logger.debug(`[GCP Cost Calculator] Converted daily cost to monthly: ${costAmount} -> ${monthlyCost}`);
                    }
                }
            }

            // Calculate hourly rate
            const hourlyRate = monthlyCost / hoursPerMonth;

            // Apply regional multiplier for consistency
            const adjustedHourlyRate = this.applyRegionalMultiplier(hourlyRate, zone);
            const adjustedMonthlyCost = adjustedHourlyRate * hoursPerMonth;

            const costData = {
                hourly: Math.round(adjustedHourlyRate * 10000) / 10000, // Round to 4 decimal places
                monthly: Math.round(adjustedMonthlyCost * 100) / 100, // Round to 2 decimal places
                currency: currency,
                region: zone ? zone.split('-').slice(0, -1).join('-') : 'us-central1',
                isEstimated: true,
                source: 'gcp_recommender_fallback'
            };

            logger.info(`[GCP Cost Calculator] ✓ Extracted cost from recommendation: ${costData.hourly}/hour, ${costData.monthly}/month (${currency})`);
            return costData;

        } catch (error) {
            logger.error(`[GCP Cost Calculator] Failed to extract cost from recommendation for ${machineType}: ${error.message}`);
            return null;
        }
    }

    /**
     * Handle pricing service failures with comprehensive error handling
     * @param {Error} error - The pricing service error
     * @param {string} machineType - Machine type for context
     * @param {string} zone - Zone for context
     * @returns {Object} Error classification and handling strategy
     */
    handlePricingServiceFailure(error, machineType, zone) {
        const errorInfo = {
            type: 'unknown',
            severity: 'error',
            retryable: false,
            fallbackAvailable: false,
            userMessage: 'Pricing data temporarily unavailable',
            logLevel: 'error'
        };

        if (!error) {
            return errorInfo;
        }

        const errorMessage = error.message?.toLowerCase() || '';
        const errorCode = error.code || error.status;

        // Classify different types of pricing failures
        if (errorMessage.includes('network') || errorMessage.includes('timeout') ||
            errorMessage.includes('econnreset') || errorMessage.includes('etimedout')) {
            errorInfo.type = 'network';
            errorInfo.severity = 'warning';
            errorInfo.retryable = true;
            errorInfo.fallbackAvailable = true;
            errorInfo.userMessage = 'Network issue accessing pricing data - using fallback';
            errorInfo.logLevel = 'warn';
        } else if (errorMessage.includes('permission') || errorMessage.includes('access denied') ||
            errorCode === 403 || errorCode === 7) {
            errorInfo.type = 'permission';
            errorInfo.severity = 'warning';
            errorInfo.retryable = false;
            errorInfo.fallbackAvailable = true;
            errorInfo.userMessage = 'Insufficient permissions for pricing data - using estimates';
            errorInfo.logLevel = 'warn';
        } else if (errorMessage.includes('rate limit') || errorMessage.includes('quota') ||
            errorCode === 429 || errorCode === 8) {
            errorInfo.type = 'rate_limit';
            errorInfo.severity = 'warning';
            errorInfo.retryable = true;
            errorInfo.fallbackAvailable = true;
            errorInfo.userMessage = 'Pricing service rate limited - using cached data';
            errorInfo.logLevel = 'warn';
        } else if (errorMessage.includes('not found') || errorMessage.includes('unknown machine type') ||
            errorCode === 404 || errorCode === 5) {
            errorInfo.type = 'unknown_machine_type';
            errorInfo.severity = 'info';
            errorInfo.retryable = false;
            errorInfo.fallbackAvailable = true;
            errorInfo.userMessage = `Pricing unavailable for ${machineType} - using estimates`;
            errorInfo.logLevel = 'info';
        } else if (errorMessage.includes('service unavailable') || errorMessage.includes('internal error') ||
            errorCode >= 500) {
            errorInfo.type = 'service_unavailable';
            errorInfo.severity = 'warning';
            errorInfo.retryable = true;
            errorInfo.fallbackAvailable = true;
            errorInfo.userMessage = 'Pricing service temporarily unavailable - using fallback';
            errorInfo.logLevel = 'warn';
        }

        // Log the error with appropriate level
        const logMessage = `[GCP Cost Calculator] Pricing service failure for ${machineType} in ${zone}: ${error.message}`;

        switch (errorInfo.logLevel) {
            case 'info':
                logger.info(logMessage);
                break;
            case 'warn':
                logger.warn(logMessage);
                break;
            case 'error':
            default:
                logger.error(logMessage);
                break;
        }

        return errorInfo;
    }

    /**
     * Get cache statistics
     * @returns {Object} Cache statistics
     */
    getCacheStats() {
        const now = Date.now();
        let validEntries = 0;
        let expiredEntries = 0;

        for (const [key, value] of this.pricingCache.entries()) {
            if (now > value.expiry) {
                expiredEntries++;
            } else {
                validEntries++;
            }
        }

        return {
            totalEntries: this.pricingCache.size,
            validEntries,
            expiredEntries,
            cacheHitRate: this.cacheHitRate || 0
        };
    }

    /**
     * Clear all cached data
     */
    clearCache() {
        const entriesCleared = this.pricingCache.size;
        this.pricingCache.clear();
        logger.info(`[GCP Cost Calculator] Cleared ${entriesCleared} cache entries`);
    }

    /**
     * Calculate costs for current and recommended instances with proper error handling
     * @param {Object} vm - VM instance object
     * @param {string} recommendedMachineType - Recommended machine type (or 'STOP'/'DELETE' for idle)
     * @param {number} hoursPerMonth - Hours per month (default: 730)
     * @returns {Object} Complete cost breakdown with current, recommended, and savings
     */
    /**
         * Calculate costs for current and recommended instances with proper error handling and fallback support
         * @param {Object} vm - VM instance object
         * @param {string} recommendedMachineType - Recommended machine type (or 'STOP'/'DELETE' for idle)
         * @param {number} hoursPerMonth - Hours per month (default: 730)
         * @param {Object} gcpRecommendation - Optional GCP recommendation for fallback cost projection
         * @returns {Object} Complete cost breakdown with current, recommended, and savings
         */
    async calculateVMCosts(vm, recommendedMachineType = null, hoursPerMonth = 730, gcpRecommendation = null) {
        try {
            const currentMachineType = vm.machineType?.split('/').pop() || vm.machineType;
            const zone = vm.zone?.split('/').pop() || vm.zone;

            if (!currentMachineType || !zone) {
                logger.warn(`[GCP Cost Calculator] Missing machine type or zone for VM ${vm.name}`);
                return this.getDefaultCostBreakdown();
            }

            // Calculate current instance cost with fallback support
            const currentCost = await this.calculateInstanceCost(currentMachineType, zone, hoursPerMonth, gcpRecommendation);

            // If no recommendation provided, return current cost only
            if (!recommendedMachineType) {
                return {
                    current_hourly_rate: currentCost.hourly,
                    current_monthly_cost: currentCost.monthly,
                    recommended_hourly_rate: currentCost.hourly,
                    recommended_monthly_cost: currentCost.monthly,
                    estimated_monthly_savings: 0,
                    savings_percentage: 0,
                    currency: currentCost.currency,
                    cost_source: currentCost.source,
                    is_optimized: true
                };
            }

            // Handle idle resource recommendations (STOP/DELETE)
            if (recommendedMachineType === 'STOP' || recommendedMachineType === 'DELETE') {
                return {
                    current_hourly_rate: currentCost.hourly,
                    current_monthly_cost: currentCost.monthly,
                    recommended_hourly_rate: 0,
                    recommended_monthly_cost: 0,
                    estimated_monthly_savings: currentCost.monthly,
                    savings_percentage: 100,
                    currency: currentCost.currency,
                    cost_source: currentCost.source,
                    is_idle_recommendation: true
                };
            }

            // Calculate recommended instance cost with fallback support
            const recommendedCost = await this.calculateInstanceCost(recommendedMachineType, zone, hoursPerMonth, gcpRecommendation);

            // Calculate savings with proper division handling
            const monthlySavings = currentCost.monthly - recommendedCost.monthly;
            const savingsPercentage = currentCost.monthly > 0 ?
                (monthlySavings / currentCost.monthly) * 100 : 0;

            // Determine if fallback was used
            const usedFallback = currentCost.source?.includes('fallback') || recommendedCost.source?.includes('fallback');

            logger.debug(`[GCP Cost Calculator] VM ${vm.name}: ${currentMachineType} (${currentCost.monthly}/mo) -> ${recommendedMachineType} (${recommendedCost.monthly}/mo) = ${monthlySavings}/mo (${savingsPercentage.toFixed(1)}%)${usedFallback ? ' [fallback used]' : ''}`);

            return {
                current_hourly_rate: currentCost.hourly,
                current_monthly_cost: currentCost.monthly,
                recommended_hourly_rate: recommendedCost.hourly,
                recommended_monthly_cost: recommendedCost.monthly,
                estimated_monthly_savings: Math.max(0, monthlySavings), // Ensure non-negative
                savings_percentage: Math.round(savingsPercentage * 10) / 10, // Round to 1 decimal
                currency: currentCost.currency,
                cost_source: usedFallback ? 'fallback' : currentCost.source,
                current_cost_source: currentCost.source,
                recommended_cost_source: recommendedCost.source,
                is_optimized: false
            };

        } catch (error) {
            logger.error(`[GCP Cost Calculator] Failed to calculate VM costs for ${vm.name}: ${error.message}`);
            return this.getDefaultCostBreakdown();
        }
    }

    /**
     * Enrich VM instances with cost data for current and recommended configurations
     * @param {Array} vms - Array of VM instances
     * @param {Array} recommendations - Array of GCP recommendations (optional)
     * @param {number} hoursPerMonth - Hours per month (default: 730)
     * @returns {Array} VMs enriched with cost data
     */
    async enrichVMsWithCosts(vms, recommendations = [], hoursPerMonth = 730) {
        logger.info(`[GCP Cost Calculator] Enriching ${vms.length} VMs with cost data`);

        try {
            // Create recommendation lookup map
            const recommendationMap = new Map();
            for (const rec of recommendations) {
                const instanceName = this.extractInstanceNameFromRecommendation(rec);
                if (instanceName) {
                    recommendationMap.set(instanceName, rec);
                }
            }

            // Process VMs in parallel with concurrency limit
            const enrichedVMs = await this.processVMsInBatches(vms, async (vm) => {
                const recommendation = recommendationMap.get(vm.name);
                const recommendedMachineType = recommendation ?
                    this.extractRecommendedMachineType(recommendation) : null;

                const costData = await this.calculateVMCosts(vm, recommendedMachineType, hoursPerMonth);

                return {
                    ...vm,
                    ...costData,
                    has_recommendation: !!recommendation,
                    recommendation_id: recommendation?.name?.split('/').pop() || null,
                    cost_calculated_at: new Date().toISOString()
                };
            });

            logger.info(`[GCP Cost Calculator] Successfully enriched ${enrichedVMs.length} VMs with cost data`);
            return enrichedVMs;

        } catch (error) {
            logger.error(`[GCP Cost Calculator] Failed to enrich VMs with costs: ${error.message}`);
            // Return VMs with default cost data rather than failing
            return vms.map(vm => ({
                ...vm,
                ...this.getDefaultCostBreakdown(),
                has_recommendation: false,
                cost_calculated_at: new Date().toISOString()
            }));
        }
    }

    /**
     * Calculate total cost savings across all VMs with recommendations
     * @param {Array} enrichedVMs - VMs with cost data
     * @returns {Object} Aggregated cost savings summary
     */
    calculateTotalSavings(enrichedVMs) {
        try {
            const summary = {
                total_vms: enrichedVMs.length,
                vms_with_recommendations: 0,
                vms_optimized: 0,
                vms_overprovisioned: 0,
                vms_underprovisioned: 0,
                total_current_monthly_cost: 0,
                total_recommended_monthly_cost: 0,
                total_monthly_savings: 0,
                average_savings_percentage: 0,
                currency: 'USD'
            };

            let totalSavingsPercentage = 0;
            let vmsWithSavings = 0;

            for (const vm of enrichedVMs) {
                summary.total_current_monthly_cost += vm.current_monthly_cost || 0;
                summary.total_recommended_monthly_cost += vm.recommended_monthly_cost || 0;
                summary.total_monthly_savings += vm.estimated_monthly_savings || 0;

                if (vm.has_recommendation) {
                    summary.vms_with_recommendations++;

                    if (vm.savings_percentage > 0) {
                        totalSavingsPercentage += vm.savings_percentage;
                        vmsWithSavings++;
                    }

                    // Classify based on savings
                    if (vm.estimated_monthly_savings > 0) {
                        summary.vms_overprovisioned++;
                    } else if (vm.estimated_monthly_savings < 0) {
                        summary.vms_underprovisioned++;
                    } else {
                        summary.vms_optimized++;
                    }
                } else {
                    summary.vms_optimized++;
                }

                // Use currency from first VM with valid currency
                if (vm.currency && summary.currency === 'USD') {
                    summary.currency = vm.currency;
                }
            }

            // Calculate average savings percentage
            summary.average_savings_percentage = vmsWithSavings > 0 ?
                Math.round((totalSavingsPercentage / vmsWithSavings) * 10) / 10 : 0;

            logger.info(`[GCP Cost Calculator] Cost summary: ${summary.vms_with_recommendations} VMs with recommendations, $${summary.total_monthly_savings.toFixed(2)}/mo potential savings`);

            return summary;

        } catch (error) {
            logger.error(`[GCP Cost Calculator] Failed to calculate total savings: ${error.message}`);
            return {
                total_vms: enrichedVMs.length,
                vms_with_recommendations: 0,
                vms_optimized: enrichedVMs.length,
                vms_overprovisioned: 0,
                vms_underprovisioned: 0,
                total_current_monthly_cost: 0,
                total_recommended_monthly_cost: 0,
                total_monthly_savings: 0,
                average_savings_percentage: 0,
                currency: 'USD'
            };
        }
    }

    /**
     * Process VMs in batches to avoid overwhelming the system
     * @param {Array} vms - Array of VMs to process
     * @param {Function} processor - Async function to process each VM
     * @param {number} batchSize - Number of VMs to process concurrently
     * @returns {Array} Processed VMs
     */
    async processVMsInBatches(vms, processor, batchSize = 10) {
        const results = [];

        for (let i = 0; i < vms.length; i += batchSize) {
            const batch = vms.slice(i, i + batchSize);
            const batchPromises = batch.map(vm => processor(vm));

            try {
                const batchResults = await Promise.all(batchPromises);
                results.push(...batchResults);

                logger.debug(`[GCP Cost Calculator] Processed batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(vms.length / batchSize)}`);
            } catch (error) {
                logger.error(`[GCP Cost Calculator] Batch processing failed: ${error.message}`);
                // Add VMs with default cost data for failed batch
                results.push(...batch.map(vm => ({
                    ...vm,
                    ...this.getDefaultCostBreakdown()
                })));
            }
        }

        return results;
    }

    /**
     * Extract instance name from GCP recommendation
     * @param {Object} recommendation - GCP recommendation object
     * @returns {string|null} Instance name or null if not found
     */
    extractInstanceNameFromRecommendation(recommendation) {
        try {
            if (!recommendation.content?.operationGroups) {
                return null;
            }

            for (const operationGroup of recommendation.content.operationGroups) {
                for (const operation of operationGroup.operations) {
                    if (operation.resource?.name) {
                        // Extract instance name from resource path
                        // Format: projects/PROJECT/zones/ZONE/instances/INSTANCE_NAME
                        const parts = operation.resource.name.split('/');
                        const instanceIndex = parts.indexOf('instances');
                        if (instanceIndex !== -1 && instanceIndex + 1 < parts.length) {
                            return parts[instanceIndex + 1];
                        }
                    }
                }
            }

            return null;
        } catch (error) {
            logger.warn(`[GCP Cost Calculator] Failed to extract instance name from recommendation: ${error.message}`);
            return null;
        }
    }

    /**
     * Extract recommended machine type from GCP recommendation
     * @param {Object} recommendation - GCP recommendation object
     * @returns {string|null} Recommended machine type or action
     */
    extractRecommendedMachineType(recommendation) {
        try {
            // Check if this is an idle resource recommendation
            if (recommendation.name?.includes('IdleResourceRecommender')) {
                return 'STOP';
            }

            if (!recommendation.content?.operationGroups) {
                return null;
            }

            for (const operationGroup of recommendation.content.operationGroups) {
                for (const operation of operationGroup.operations) {
                    if (operation.action === 'replace' && operation.resource?.machineType) {
                        // Extract machine type from full resource path
                        const machineTypePath = operation.resource.machineType;
                        return machineTypePath.split('/').pop();
                    }
                }
            }

            return null;
        } catch (error) {
            logger.warn(`[GCP Cost Calculator] Failed to extract recommended machine type: ${error.message}`);
            return null;
        }
    }

    /**
     * Get default cost breakdown for error cases
     * @returns {Object} Default cost structure
     */
    getDefaultCostBreakdown() {
        return {
            current_hourly_rate: 0,
            current_monthly_cost: 0,
            recommended_hourly_rate: 0,
            recommended_monthly_cost: 0,
            estimated_monthly_savings: 0,
            savings_percentage: 0,
            currency: 'USD',
            cost_source: 'fallback',
            is_optimized: true
        };
    }
}

module.exports = {
    testConnection,
    fetchResources,
    fetchResourcesSync,
    estimateGCPCost,
    // GCP Recommender API functions
    initializeGCPRecommenderClient,
    testGCPRecommenderConnection,
    fetchMachineTypeRecommendations,
    fetchIdleResourceRecommendations,
    GCPRecommenderError,
    GCPRecommenderLogger,
    retryGCPRecommenderOperation,
    validateGCPRecommenderResponse,
    classifyGCPRecommenderError,
    // GCP Recommendation Transformer
    GCPRecommendationTransformer,
    // GCP Cost Calculator
    GCPCostCalculator,
    // Cost calculation helper functions
    enrichVMsWithGCPCosts,
    calculateMonthlyCost,
    calculateSavingsPercentage,
    validateCostData
};
