const { CloudWatchClient } = require("@aws-sdk/client-cloudwatch");
const CloudConnection = require('../models/CloudConnection');
const Resource = require('../models/Resource');
const { fetchRealtimeMetrics, fetchComputeOptimizerRecommendations } = require('../services/awsService');
const logger = require('../utils/logger');
const { diagnoseComputeOptimizer } = require('../utils/computeOptimizerDiagnostics');
const mlService = require('../services/mlService');
const featureTransformer = require('../services/featureTransformer');
const recommendationHandler = require('../services/recommendationHandler');

/**
 * Get GCP Cloud Monitoring metrics for an instance
 * GET /api/resources/instances/:instanceId/gcp-metrics?range=1h&hours=1
 */
const getGCPInstanceMetrics = async (req, res) => {
    try {
        const { instanceId } = req.params;
        const { range = '1h', hours = 1 } = req.query;

        // Validate instanceId (GCP instance IDs are different format)
        if (!instanceId || typeof instanceId !== 'string') {
            return res.status(400).json({
                error: 'Invalid instanceId parameter',
                message: 'instanceId must be a valid GCP instance ID'
            });
        }

        // Find the resource to get project and zone info
        const resource = await Resource.findOne({ resourceId: instanceId });
        if (!resource) {
            return res.status(404).json({
                error: 'Instance not found',
                message: `GCP instance ${instanceId} not found in database`
            });
        }

        // Check if instance is too new for the requested range
        const instanceAge = getInstanceAgeInHours(resource.launchTime || resource.createdAt || resource.created_at);
        if (instanceAge !== null && instanceAge < parseFloat(hours)) {
            return res.status(200).json({
                error: 'Instance too new',
                message: `Instance was started ${instanceAge.toFixed(1)} hours ago, but requesting ${hours} hours of data`,
                suggestion: 'Try a shorter time range',
                instanceAge: instanceAge,
                requestedHours: parseFloat(hours),
                cpu: null,
                memory: null,
                range: range,
                lastUpdated: new Date().toISOString()
            });
        }

        // For now, return simulated data based on existing resource metrics
        // In a real implementation, this would call GCP Cloud Monitoring API
        const simulatedMetrics = {
            cpu: resource.avgCpuUtilization || resource.cpuAvg || null,
            memory: resource.avgMemoryUtilization || resource.memoryAvg || null,
            range: range,
            rangeHours: parseFloat(hours),
            provider: 'GCP',
            dataPoints: Math.floor(parseFloat(hours) * 60 / 5), // 5-minute intervals
            resolution: parseFloat(hours) <= 6 ? '1min' : parseFloat(hours) <= 24 ? '5min' : '1hour',
            lastUpdated: new Date().toISOString(),
            instanceAge: instanceAge
        };

        return res.status(200).json(simulatedMetrics);

    } catch (error) {
        logger.error('[GCP Metrics API] Error:', {
            instanceId: req.params.instanceId,
            range: req.query.range,
            error: error.message
        });

        return res.status(500).json({
            error: 'Failed to fetch GCP metrics',
            message: error.message,
            provider: 'GCP'
        });
    }
};

/**
 * Get Azure Monitor metrics for an instance
 * GET /api/resources/instances/:instanceId/azure-metrics?range=1h&hours=1
 */
const getAzureInstanceMetrics = async (req, res) => {
    try {
        const { instanceId } = req.params;
        const { range = '1h', hours = 1 } = req.query;

        // Validate instanceId
        if (!instanceId || typeof instanceId !== 'string') {
            return res.status(400).json({
                error: 'Invalid instanceId parameter',
                message: 'instanceId must be a valid Azure VM resource ID'
            });
        }

        // Find the resource to get subscription and resource group info
        const resource = await Resource.findOne({ resourceId: instanceId });
        if (!resource) {
            return res.status(404).json({
                error: 'Instance not found',
                message: `Azure VM ${instanceId} not found in database`
            });
        }

        // Check if instance is too new for the requested range
        const instanceAge = getInstanceAgeInHours(resource.launchTime || resource.createdAt || resource.created_at);
        if (instanceAge !== null && instanceAge < parseFloat(hours)) {
            return res.status(200).json({
                error: 'Instance too new',
                message: `Instance was started ${instanceAge.toFixed(1)} hours ago, but requesting ${hours} hours of data`,
                suggestion: 'Try a shorter time range',
                instanceAge: instanceAge,
                requestedHours: parseFloat(hours),
                cpu: null,
                memory: null,
                range: range,
                lastUpdated: new Date().toISOString()
            });
        }

        // For now, return simulated data based on existing resource metrics
        // In a real implementation, this would call Azure Monitor API
        const simulatedMetrics = {
            cpu: resource.avgCpuUtilization || resource.cpuAvg || null,
            memory: resource.avgMemoryUtilization || resource.memoryAvg || null,
            range: range,
            rangeHours: parseFloat(hours),
            provider: 'Azure',
            dataPoints: Math.floor(parseFloat(hours) * 60 / 15), // 15-minute intervals for Azure
            resolution: parseFloat(hours) <= 6 ? '1min' : parseFloat(hours) <= 24 ? '15min' : '1hour',
            lastUpdated: new Date().toISOString(),
            instanceAge: instanceAge,
            cached: true // Azure metrics are cached
        };

        return res.status(200).json(simulatedMetrics);

    } catch (error) {
        logger.error('[Azure Metrics API] Error:', {
            instanceId: req.params.instanceId,
            range: req.query.range,
            error: error.message
        });

        return res.status(500).json({
            error: 'Failed to fetch Azure metrics',
            message: error.message,
            provider: 'Azure'
        });
    }
};

/**
 * Get real-time instance usage metrics from CloudWatch (Legacy endpoint)
 * GET /api/resources/instances/:instanceId/usage?range=3h
 */
const getInstanceUsage = async (req, res) => {
    try {
        const { instanceId } = req.params;
        const { range = '1h' } = req.query;

        // Validate instanceId
        if (!instanceId || typeof instanceId !== 'string' || !instanceId.startsWith('i-')) {
            return res.status(400).json({
                error: 'Invalid instanceId parameter',
                message: 'instanceId must be a valid EC2 instance ID (e.g., i-1234567890abcdef0)'
            });
        }

        // Validate range parameter (legacy ranges only)
        const validRanges = ['1h', '3h', '12h', '1d', '3d', '1w'];
        if (!validRanges.includes(range)) {
            return res.status(400).json({
                error: 'Invalid range parameter',
                message: `range must be one of: ${validRanges.join(', ')}`
            });
        }

        // Find the resource to get region and user info
        const resource = await Resource.findOne({ resourceId: instanceId });
        if (!resource) {
            return res.status(404).json({
                error: 'Instance not found',
                message: `Instance ${instanceId} not found in database`
            });
        }

        // Get AWS credentials for this user
        const cloudConnection = await CloudConnection.findOne({
            userId: resource.userId,
            provider: 'AWS'
        });

        if (!cloudConnection) {
            return res.status(404).json({
                error: 'AWS connection not found',
                message: 'No AWS credentials configured for this user'
            });
        }

        // Create CloudWatch client
        const cloudWatchClient = new CloudWatchClient({
            region: resource.region,
            credentials: {
                accessKeyId: cloudConnection.credentials.accessKeyId,
                secretAccessKey: cloudConnection.credentials.secretAccessKey
            }
        });

        // Fetch real-time metrics
        const metrics = await fetchRealtimeMetrics(
            cloudWatchClient,
            instanceId,
            range,
            resource.region
        );

        // Return formatted response (legacy format)
        return res.status(200).json({
            cpu: metrics.cpu,
            memory: metrics.memory,
            range: range,
            lastUpdated: new Date().toISOString()
        });

    } catch (error) {
        logger.error('[Instance Usage API] Error:', {
            instanceId: req.params.instanceId,
            range: req.query.range,
            error: error.message,
            errorCode: error.code
        });

        // Handle AWS-specific errors
        if (error.code === 'InvalidClientTokenId' || error.code === 'SignatureDoesNotMatch') {
            return res.status(401).json({
                error: 'AWS authentication failed',
                message: 'Invalid AWS credentials. Please check your AWS configuration.'
            });
        }

        if (error.code === 'AccessDenied' || error.code === 'UnauthorizedOperation') {
            return res.status(403).json({
                error: 'AWS access denied',
                message: 'Insufficient permissions to access CloudWatch metrics. Required: cloudwatch:GetMetricStatistics'
            });
        }

        if (error.code === 'TimeoutError' || error.code === 'NetworkingError') {
            return res.status(504).json({
                error: 'CloudWatch request timeout',
                message: 'Failed to retrieve metrics from AWS CloudWatch. Please try again.'
            });
        }

        // Generic error
        return res.status(500).json({
            error: 'Failed to fetch instance usage',
            message: error.message
        });
    }
};

/**
 * Helper function to calculate instance age in hours
 */
const getInstanceAgeInHours = (launchTime) => {
    if (!launchTime) return null;

    const now = new Date();
    const launch = new Date(launchTime);
    const diffMs = now - launch;
    return diffMs / (1000 * 60 * 60); // Convert to hours
};

/**
 * Enhanced AWS CloudWatch metrics with better time range support
 * GET /api/resources/instances/:instanceId/usage?range=1h&hours=1
 */
const getEnhancedInstanceUsage = async (req, res) => {
    try {
        const { instanceId } = req.params;
        const { range = '1h', hours } = req.query;

        // Convert range to hours if hours not provided
        const rangeToHours = {
            '15m': 0.25, '30m': 0.5, '1h': 1, '3h': 3, '6h': 6, '12h': 12,
            '1d': 24, '2d': 48, '3d': 72, '7d': 168, '14d': 336, '30d': 720
        };
        const requestedHours = hours ? parseFloat(hours) : (rangeToHours[range] || 1);

        // Validate instanceId
        if (!instanceId || typeof instanceId !== 'string' || !instanceId.startsWith('i-')) {
            return res.status(400).json({
                error: 'Invalid instanceId parameter',
                message: 'instanceId must be a valid EC2 instance ID (e.g., i-1234567890abcdef0)'
            });
        }

        // Validate range parameter
        const validRanges = ['15m', '30m', '1h', '3h', '6h', '12h', '1d', '2d', '3d', '7d', '14d', '30d'];
        if (!validRanges.includes(range)) {
            return res.status(400).json({
                error: 'Invalid range parameter',
                message: `range must be one of: ${validRanges.join(', ')}`
            });
        }

        // Find the resource to get region and user info
        const resource = await Resource.findOne({ resourceId: instanceId });
        if (!resource) {
            return res.status(404).json({
                error: 'Instance not found',
                message: `Instance ${instanceId} not found in database`
            });
        }

        // Check if instance is too new for the requested range
        const instanceAge = getInstanceAgeInHours(resource.launchTime || resource.createdAt || resource.created_at);
        if (instanceAge !== null && instanceAge < requestedHours) {
            return res.status(200).json({
                error: 'Instance too new',
                message: `Instance was started ${instanceAge.toFixed(1)} hours ago, but requesting ${requestedHours} hours of data`,
                suggestion: `Try a shorter time range like "${instanceAge < 1 ? '15m' : instanceAge < 3 ? '1h' : instanceAge < 12 ? '3h' : '12h'}"`,
                instanceAge: instanceAge,
                requestedHours: requestedHours,
                cpu: null,
                memory: null,
                range: range,
                lastUpdated: new Date().toISOString()
            });
        }

        // Get AWS credentials for this user
        const cloudConnection = await CloudConnection.findOne({
            userId: resource.userId,
            provider: 'AWS'
        });

        if (!cloudConnection) {
            return res.status(404).json({
                error: 'AWS connection not found',
                message: 'No AWS credentials configured for this user'
            });
        }

        // Create CloudWatch client
        const cloudWatchClient = new CloudWatchClient({
            region: resource.region,
            credentials: {
                accessKeyId: cloudConnection.credentials.accessKeyId,
                secretAccessKey: cloudConnection.credentials.secretAccessKey
            }
        });

        // Fetch real-time metrics with enhanced range support
        const metrics = await fetchRealtimeMetrics(
            cloudWatchClient,
            instanceId,
            range,
            resource.region
        );

        // Return enhanced response with additional metadata
        return res.status(200).json({
            cpu: metrics.cpu,
            memory: metrics.memory,
            range: range,
            rangeHours: requestedHours,
            provider: 'AWS',
            dataPoints: Math.floor(requestedHours * 60 / (requestedHours <= 6 ? 1 : requestedHours <= 24 ? 5 : 60)),
            resolution: requestedHours <= 6 ? '1min' : requestedHours <= 24 ? '5min' : '1hour',
            lastUpdated: new Date().toISOString(),
            instanceAge: instanceAge
        });

    } catch (error) {
        logger.error('[Enhanced Instance Usage API] Error:', {
            instanceId: req.params.instanceId,
            range: req.query.range,
            error: error.message,
            errorCode: error.code
        });

        // Handle AWS-specific errors with enhanced messaging
        if (error.code === 'InvalidClientTokenId' || error.code === 'SignatureDoesNotMatch') {
            return res.status(401).json({
                error: 'AWS authentication failed',
                message: 'Invalid AWS credentials. Please check your AWS configuration.',
                provider: 'AWS'
            });
        }

        if (error.code === 'AccessDenied' || error.code === 'UnauthorizedOperation') {
            return res.status(403).json({
                error: 'AWS access denied',
                message: 'Insufficient permissions to access CloudWatch metrics. Required: cloudwatch:GetMetricStatistics',
                provider: 'AWS'
            });
        }

        if (error.code === 'TimeoutError' || error.code === 'NetworkingError') {
            return res.status(504).json({
                error: 'CloudWatch request timeout',
                message: 'Failed to retrieve metrics from AWS CloudWatch. Please try again.',
                provider: 'AWS'
            });
        }

        // Generic error
        return res.status(500).json({
            error: 'Failed to fetch instance usage',
            message: error.message,
            provider: 'AWS'
        });
    }
};

const getResourceMetrics = async (req, res) => {
    try {
        const { resourceId } = req.params;
        const resource = await Resource.findOne({ resourceId });

        const mapMetric = (historyArr, offset = 0) => {
            if (!historyArr || historyArr.length === 0) return [];
            return historyArr.map(h => ({ timestamp: h.timestamp, value: h.value + offset }));
        };

        if (resource) {
            const h = resource.metricsHistory || {};
            const metrics = {
                cpu: { avg: mapMetric(h.cpu), p95: mapMetric(h.cpu, 5), max: mapMetric(h.cpu, 15) },
                memory: { avg: mapMetric(h.memory) },
                disk: { iops: mapMetric(h.disk) },
                network: { in: mapMetric(h.networkIn), out: mapMetric(h.networkOut) },
                db: {
                    connections: mapMetric(h.dbConnections),
                    latency: mapMetric(h.dbLatency),
                    memory_pressure: mapMetric(h.dbMemoryPressure),
                    iops_read: mapMetric(h.dbIopsRead),
                    iops_write: mapMetric(h.dbIopsWrite),
                    storage_used: mapMetric(h.dbStorageUsed),
                    storage_free: mapMetric(h.dbStorageFree)
                }
            };
            return res.json({
                details: {
                    id: resource.resourceId,
                    name: resource.name,
                    provider: resource.provider,
                    region: resource.region,
                    type: resource.resourceType,
                    status: resource.optimizationStatus,
                    cost: resource.estimatedMonthlyCost,
                    savings: resource.estimatedSavings,
                    recommendation: resource.recommendation,
                    recommendedType: resource.recommendation,
                    vCpu: resource.vCpu,
                    memoryGb: resource.memoryGb,
                    service: resource.service
                },
                metrics
            });
        }
        res.status(404).json({ error: "Resource not found" });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch metrics" });
    }
};

/**
 * Get AWS Compute Optimizer recommendations for EC2 instances
 * GET /api/resources/compute-optimizer/recommendations
 */
const getComputeOptimizerRecommendations = async (req, res) => {
    try {
        const userId = req.user._id; // From auth middleware

        // Get AWS credentials for this user
        const cloudConnection = await CloudConnection.findOne({
            userId: userId,
            provider: 'AWS'
        });

        if (!cloudConnection) {
            return res.status(404).json({
                error: 'AWS connection not found',
                message: 'No AWS credentials configured. Please connect your AWS account first.'
            });
        }

        // Fetch recommendations from AWS Compute Optimizer
        const recommendations = await fetchComputeOptimizerRecommendations({
            accessKeyId: cloudConnection.credentials.accessKeyId,
            secretAccessKey: cloudConnection.credentials.secretAccessKey
        });

        // Return recommendations
        return res.status(200).json({
            success: true,
            count: recommendations.length,
            recommendations: recommendations
        });

    } catch (error) {
        logger.error('[Compute Optimizer API] Error:', {
            userId: req.user?.id,
            error: error.message,
            errorCode: error.code
        });

        // Handle AWS-specific errors
        if (error.name === 'OptInRequiredException') {
            return res.status(400).json({
                error: 'Compute Optimizer not enabled',
                message: 'AWS Compute Optimizer is not enabled for this account. Please enable it in the AWS Console.'
            });
        }

        if (error.name === 'AccessDeniedException' || error.code === 'AccessDenied') {
            return res.status(403).json({
                error: 'AWS access denied',
                message: 'Insufficient permissions. Required: compute-optimizer:GetEC2InstanceRecommendations'
            });
        }

        if (error.code === 'InvalidClientTokenId' || error.code === 'SignatureDoesNotMatch') {
            return res.status(401).json({
                error: 'AWS authentication failed',
                message: 'Invalid AWS credentials. Please check your AWS configuration.'
            });
        }

        // Generic error
        return res.status(500).json({
            error: 'Failed to fetch Compute Optimizer recommendations',
            message: error.message
        });
    }
};

/**
 * Get AWS Compute Optimizer recommendations for a specific EC2 instance
 * GET /api/resources/instances/:instanceId/compute-optimizer
 */
const getInstanceComputeOptimizerRecommendation = async (req, res) => {
    try {
        const { instanceId } = req.params;

        // Validate instanceId
        if (!instanceId || typeof instanceId !== 'string' || !instanceId.startsWith('i-')) {
            return res.status(400).json({
                error: 'Invalid instanceId parameter',
                message: 'instanceId must be a valid EC2 instance ID (e.g., i-1234567890abcdef0)'
            });
        }

        // Get AWS credentials for this user (from CloudConnection)
        const userId = req.user._id;
        let cloudConnection = await CloudConnection.findOne({
            userId: userId,
            provider: 'AWS'
        });

        // User must have connected their AWS account via CloudConnection
        if (!cloudConnection) {
            logger.warn(`[Instance Compute Optimizer API] No AWS CloudConnection found for user ${userId}`);
            return res.status(200).json({
                success: true,
                hasRecommendation: false,
                message: 'No AWS credentials configured. Please connect your AWS account in the Cloud Connections page.',
                recommendation: null,
                error: {
                    type: 'NoCredentials',
                    action: 'Connect your AWS account'
                }
            });
        }

        const credentials = {
            accessKeyId: cloudConnection.credentials.accessKeyId,
            secretAccessKey: cloudConnection.credentials.secretAccessKey
        };

        // Try to find the resource in database (optional - for region info)
        const resource = await Resource.findOne({ resourceId: instanceId });
        const region = resource?.region || 'us-east-1'; // Default to us-east-1 if not found

        // Fetch ALL recommendations and filter by instance ID
        // This avoids the need to construct the ARN with account ID
        logger.info(`[Instance Compute Optimizer API] Fetching recommendations for instance ${instanceId}`);

        const recommendations = await fetchComputeOptimizerRecommendations({
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey
        }, region, null); // Pass null to fetch all recommendations

        logger.info(`[Instance Compute Optimizer API] Total recommendations fetched: ${recommendations.length}`);

        // Find the recommendation for this specific instance
        const recommendation = recommendations.find(rec => rec.instance_id === instanceId);

        if (!recommendation) {
            logger.warn(`[Instance Compute Optimizer API] No recommendation found for instance ${instanceId}`);
            logger.warn(`[Instance Compute Optimizer API] Available instance IDs:`, recommendations.map(r => r.instance_id));

            return res.status(200).json({
                success: true,
                hasRecommendation: false,
                message: 'No recommendations available or insufficient data',
                recommendation: null,
                debug: {
                    totalRecommendations: recommendations.length,
                    availableInstanceIds: recommendations.map(r => r.instance_id),
                    requestedInstanceId: instanceId
                }
            });
        }

        logger.info(`[Instance Compute Optimizer API] ✅ Found recommendation for ${instanceId}:`);
        logger.info(`  - Finding: ${recommendation.finding}`);
        logger.info(`  - Finding Reasons: ${JSON.stringify(recommendation.finding_reasons)}`);
        logger.info(`  - Recommendation Options: ${recommendation.recommendation_options?.length || 0}`);
        logger.info(`  - Current CPU: ${recommendation.current_cpu_utilization}%`);
        logger.info(`  - Current Memory: ${recommendation.current_memory_utilization}%`);
        logger.info(`  - Estimated Savings: $${recommendation.estimated_monthly_savings}`);

        // Return the recommendation
        return res.status(200).json({
            success: true,
            hasRecommendation: true,
            recommendation: recommendation
        });

    } catch (error) {
        logger.error('[Instance Compute Optimizer API] Error:', {
            instanceId: req.params.instanceId,
            error: error.message,
            errorCode: error.code,
            errorName: error.name,
            errorStack: error.stack
        });

        logger.error(`[Instance Compute Optimizer API] ========== ERROR DETAILS ==========`);
        logger.error(`  - Instance ID: ${req.params.instanceId}`);
        logger.error(`  - Error Name: ${error.name}`);
        logger.error(`  - Error Code: ${error.code}`);
        logger.error(`  - Error Message: ${error.message}`);
        logger.error(`  - Full Error:`, JSON.stringify(error, null, 2));
        logger.error(`[Instance Compute Optimizer API] ==========================================`);

        // Handle AWS-specific errors
        if (error.name === 'OptInRequiredException') {
            logger.error(`[Instance Compute Optimizer API] ⚠️ COMPUTE OPTIMIZER NOT ENABLED!`);
            logger.error(`  - Go to: https://console.aws.amazon.com/compute-optimizer/`);
            logger.error(`  - Click "Get started" or "Opt in"`);

            return res.status(200).json({
                success: true,
                hasRecommendation: false,
                message: 'AWS Compute Optimizer is not enabled for this account',
                recommendation: null,
                error: {
                    type: 'OptInRequired',
                    action: 'Enable Compute Optimizer in AWS Console'
                }
            });
        }

        if (error.name === 'AccessDeniedException' || error.code === 'AccessDenied') {
            logger.error(`[Instance Compute Optimizer API] ⚠️ PERMISSION DENIED!`);
            logger.error(`  - Missing IAM permission: compute-optimizer:GetEC2InstanceRecommendations`);

            return res.status(200).json({
                success: true,
                hasRecommendation: false,
                message: 'Insufficient permissions to access Compute Optimizer',
                recommendation: null,
                error: {
                    type: 'AccessDenied',
                    action: 'Add compute-optimizer:GetEC2InstanceRecommendations permission to IAM user'
                }
            });
        }

        // Generic error - return 200 with no recommendation instead of 500
        return res.status(200).json({
            success: true,
            hasRecommendation: false,
            message: error.message || 'Failed to fetch Compute Optimizer recommendation',
            recommendation: null,
            error: {
                type: error.name || 'Unknown',
                message: error.message
            }
        });
    }
};

/**
 * Diagnostic endpoint to check AWS Compute Optimizer setup
 * GET /api/resources/compute-optimizer/diagnostics
 */
const diagnoseComputeOptimizerSetup = async (req, res) => {
    try {
        const userId = req.user._id;

        // Get AWS credentials
        const cloudConnection = await CloudConnection.findOne({
            userId: userId,
            provider: 'AWS'
        });

        if (!cloudConnection) {
            return res.status(404).json({
                error: 'AWS connection not found',
                message: 'No AWS credentials configured'
            });
        }

        // Run diagnostics
        const diagnosticResult = await diagnoseComputeOptimizer({
            accessKeyId: cloudConnection.credentials.accessKeyId,
            secretAccessKey: cloudConnection.credentials.secretAccessKey
        });

        return res.status(200).json({
            success: diagnosticResult.success,
            result: diagnosticResult
        });

    } catch (error) {
        logger.error('[Compute Optimizer Diagnostics] Error:', error);
        return res.status(500).json({
            error: 'Diagnostic failed',
            message: error.message
        });
    }
};

/**
 * Get ML-based recommendation for a single resource
 * GET /api/resources/:id/recommendation
 * 
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5
 */
const getRecommendation = async (req, res) => {
    try {
        const { id } = req.params;

        // Validate resource ID
        if (!id) {
            return res.status(400).json({
                success: false,
                error: 'Missing required parameter: id',
                code: 'INVALID_INPUT'
            });
        }

        logger.info(`Getting ML recommendation for resource ${id}`);

        // Fetch resource from database
        const resource = await Resource.findById(id);
        if (!resource) {
            return res.status(404).json({
                success: false,
                error: 'Resource not found',
                code: 'RESOURCE_NOT_FOUND'
            });
        }

        // Transform resource to ML features
        let features;
        try {
            features = featureTransformer.transformResource(resource);
        } catch (transformError) {
            logger.error('Feature transformation failed', {
                resourceId: id,
                error: transformError.message
            });

            return res.status(500).json({
                success: false,
                error: 'Failed to transform resource features',
                code: 'TRANSFORMATION_ERROR',
                details: transformError.message
            });
        }

        // Check if resource has sufficient data for ML prediction
        if (!features || features.cpu_avg === null || features.cpu_avg === undefined) {
            return res.status(200).json({
                success: true,
                data: {
                    instance_id: resource.resourceId,
                    status: 'insufficient_data',
                    prediction: 'Insufficient Data',
                    confidence: 0,
                    confidence_flag: 'insufficient',
                    recommendation: null,
                    message: 'Insufficient CPU metrics for ML prediction'
                }
            });
        }

        // Get prediction from ML service
        try {
            const prediction = await mlService.predictSingle(features);

            // Process response with recommendation handler
            const processedResponse = recommendationHandler.processSingleResponse(prediction, resource);
            const enrichedResponse = recommendationHandler.enrichResponse(processedResponse);

            return res.status(200).json({
                success: true,
                data: enrichedResponse
            });

        } catch (mlError) {
            // ML service unavailable - return 503
            logger.error('ML service error for single prediction', {
                resourceId: id,
                error: mlError.message
            });

            return res.status(503).json({
                success: false,
                error: 'ML service is currently unavailable',
                code: 'ML_SERVICE_UNAVAILABLE',
                details: mlError.message
            });
        }

    } catch (error) {
        logger.error('Error getting recommendation', {
            resourceId: req.params.id,
            error: error.message,
            stack: error.stack
        });

        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            code: 'INTERNAL_ERROR',
            details: error.message
        });
    }
};

/**
 * Get ML-based recommendations for multiple resources (batch)
 * POST /api/resources/recommendations/batch
 * 
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5
 */
const getBatchRecommendations = async (req, res) => {
    try {
        const { resource_ids } = req.body;

        // Validate request body
        if (!resource_ids || !Array.isArray(resource_ids)) {
            return res.status(400).json({
                success: false,
                error: 'Missing or invalid resource_ids array',
                code: 'INVALID_INPUT'
            });
        }

        // Validate batch size (max 1000)
        if (resource_ids.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'resource_ids array cannot be empty',
                code: 'INVALID_INPUT'
            });
        }

        if (resource_ids.length > 1000) {
            return res.status(400).json({
                success: false,
                error: 'Batch size exceeds maximum of 1000 resources',
                code: 'BATCH_SIZE_EXCEEDED'
            });
        }

        logger.info(`Getting batch ML recommendations for ${resource_ids.length} resources`);

        // Fetch resources from database
        const resources = await Resource.find({
            _id: { $in: resource_ids }
        });

        if (resources.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'No resources found with provided IDs',
                code: 'RESOURCES_NOT_FOUND'
            });
        }

        logger.info(`Found ${resources.length} resources in database`);

        // Transform resources to ML features
        let enrichedVMs;
        try {
            enrichedVMs = featureTransformer.transformResourceBatch(resources);
        } catch (transformError) {
            logger.error('Batch feature transformation failed', {
                batchSize: resource_ids.length,
                error: transformError.message
            });

            return res.status(500).json({
                success: false,
                error: 'Failed to transform resource features',
                code: 'TRANSFORMATION_ERROR',
                details: transformError.message
            });
        }

        // Process VMs with ML service
        try {
            const predictions = await mlService.processVMsWithML(enrichedVMs);

            // Process responses with recommendation handler
            const enrichedResponses = predictions.map((prediction, index) => {
                const originalResource = resources[index] || {};
                const processedResponse = recommendationHandler.processSingleResponse(prediction, originalResource);
                return recommendationHandler.enrichResponse(processedResponse);
            });

            // Calculate batch statistics
            const stats = {
                total: enrichedResponses.length,
                optimal: enrichedResponses.filter(r => r.prediction === 'Optimal').length,
                oversized: enrichedResponses.filter(r => r.prediction === 'Oversized').length,
                undersized: enrichedResponses.filter(r => r.prediction === 'Undersized').length,
                zombie: enrichedResponses.filter(r => r.prediction === 'Zombie').length,
                insufficient_data: enrichedResponses.filter(r => r.prediction === 'Insufficient Data').length,
                ml_service_error: enrichedResponses.filter(r => r.prediction === 'Error').length
            };

            logger.info('Batch recommendations completed', {
                total: stats.total,
                optimal: stats.optimal,
                oversized: stats.oversized,
                undersized: stats.undersized,
                zombie: stats.zombie,
                insufficient_data: stats.insufficient_data,
                errors: stats.ml_service_error
            });

            return res.status(200).json({
                success: true,
                data: {
                    results: enrichedResponses,
                    statistics: stats
                }
            });

        } catch (mlError) {
            // ML service unavailable - return 503
            logger.error('ML service error for batch prediction', {
                batchSize: resource_ids.length,
                error: mlError.message
            });

            return res.status(503).json({
                success: false,
                error: 'ML service is currently unavailable',
                code: 'ML_SERVICE_UNAVAILABLE',
                details: mlError.message
            });
        }

    } catch (error) {
        logger.error('Error getting batch recommendations', {
            error: error.message,
            stack: error.stack
        });

        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            code: 'INTERNAL_ERROR',
            details: error.message
        });
    }
};

module.exports = {
    getResourceMetrics,
    getInstanceUsage,
    getEnhancedInstanceUsage,
    getGCPInstanceMetrics,
    getAzureInstanceMetrics,
    getComputeOptimizerRecommendations,
    getInstanceComputeOptimizerRecommendation,
    diagnoseComputeOptimizerSetup,
    getRecommendation,
    getBatchRecommendations
};
