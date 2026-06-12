const { EC2Client, DescribeInstancesCommand, DescribeImagesCommand, DescribeInstanceTypesCommand } = require("@aws-sdk/client-ec2");
const { CloudWatchClient, GetMetricStatisticsCommand } = require("@aws-sdk/client-cloudwatch");
const { ComputeOptimizerClient, GetEC2InstanceRecommendationsCommand } = require("@aws-sdk/client-compute-optimizer");
const { S3Client, ListBucketsCommand } = require("@aws-sdk/client-s3");
const { STSClient, GetCallerIdentityCommand } = require("@aws-sdk/client-sts");
const Resource = require('../models/Resource');
const logger = require('../utils/logger');
const { normalizeVM } = require('./normalizationService');
const { enrichVMBatch, trackUnresolvableInstance } = require('./enrichmentService');
const { processVMsInBatches } = require('./mlService');
const { validateVMBatch, markVMWithError } = require('../utils/dataValidator');

/**
 * Transform AWS Compute Optimizer finding format to frontend format
 * AWS returns: OVER_PROVISIONED, UNDER_PROVISIONED, OPTIMIZED, NOT_AVAILABLE
 * Frontend expects: Overprovisioned, Underprovisioned, Optimized, NotAvailable
 * @param {string} awsFinding - Finding from AWS Compute Optimizer
 * @returns {string} Transformed finding for frontend
 */
const transformComputeOptimizerFinding = (awsFinding) => {
    if (!awsFinding) return null;

    const findingMap = {
        'OVER_PROVISIONED': 'Overprovisioned',
        'UNDER_PROVISIONED': 'Underprovisioned',
        'OPTIMIZED': 'Optimized',
        'NOT_AVAILABLE': 'NotAvailable'
    };

    return findingMap[awsFinding] || awsFinding;
};

/**
 * Convert time range string to seconds
 * @param {string} range - Time range (1h, 3h, 12h, 1d, 3d, 1w)
 * @returns {number} Duration in seconds
 */
const convertTimeRangeToSeconds = (range) => {
    const timeRangeMap = {
        '1h': 3600,        // 1 hour
        '3h': 10800,       // 3 hours
        '12h': 43200,      // 12 hours
        '1d': 86400,       // 24 hours
        '3d': 259200,      // 72 hours
        '1w': 604800       // 7 days
    };
    return timeRangeMap[range] || 3600; // Default to 1 hour
};

/**
 * Clamp value between 0 and 100 with 2 decimal places
 * @param {number} value - Value to clamp
 * @returns {number} Clamped value (0-100) with 2 decimals
 */
const clampValue = (value) => {
    if (value > 100) return 100;
    if (value < 0) return 0;
    return Math.round(value * 100) / 100;
};

/**
 * Calculate average from CloudWatch datapoints
 * Filters out null/undefined values before averaging
 * @param {Array} datapoints - CloudWatch datapoints array
 * @returns {number|null} Average value or null if no valid datapoints
 */
const calculateAverage = (datapoints) => {
    if (!datapoints || datapoints.length === 0) return null;

    const validDatapoints = datapoints.filter(dp =>
        dp.Average !== null &&
        dp.Average !== undefined &&
        !isNaN(dp.Average)
    );

    if (validDatapoints.length === 0) return null;

    const sum = validDatapoints.reduce((acc, dp) => acc + dp.Average, 0);
    const average = sum / validDatapoints.length;

    return clampValue(average);
};

/**
 * Fetch real-time metrics from CloudWatch for a specific instance
 * @param {CloudWatchClient} cloudWatchClient - AWS CloudWatch client
 * @param {string} instanceId - EC2 instance ID
 * @param {string} timeRange - Time range (1h, 3h, 12h, 1d, 3d, 1w)
 * @param {string} region - AWS region
 * @returns {Object} Metrics object with cpu, memory, and datapoint counts
 */
const fetchRealtimeMetrics = async (cloudWatchClient, instanceId, timeRange, region) => {
    try {
        logger.info(`[Realtime Metrics] Fetching metrics for ${instanceId} in ${region} (range: ${timeRange})`);

        const seconds = convertTimeRangeToSeconds(timeRange);
        const endTime = new Date();
        const startTime = new Date(endTime.getTime() - (seconds * 1000));

        logger.info(`[Realtime Metrics] Time window: ${startTime.toISOString()} to ${endTime.toISOString()}`);

        // Fetch CPU metrics from AWS/EC2 namespace
        const cpuCommand = new GetMetricStatisticsCommand({
            Namespace: 'AWS/EC2',
            MetricName: 'CPUUtilization',
            Dimensions: [{ Name: 'InstanceId', Value: instanceId }],
            StartTime: startTime,
            EndTime: endTime,
            Period: 300, // 5 minutes
            Statistics: ['Average']
        });

        const cpuData = await cloudWatchClient.send(cpuCommand);
        const cpuDatapoints = cpuData.Datapoints || [];
        const cpuAverage = calculateAverage(cpuDatapoints);

        logger.info(`[Realtime Metrics] CPU: ${cpuDatapoints.length} datapoints, average: ${cpuAverage}%`);

        // Fetch memory metrics from CWAgent namespace
        let memoryAverage = null;
        try {
            const memoryCommand = new GetMetricStatisticsCommand({
                Namespace: 'CWAgent',
                MetricName: 'mem_used_percent',
                Dimensions: [{ Name: 'InstanceId', Value: instanceId }],
                StartTime: startTime,
                EndTime: endTime,
                Period: 300, // 5 minutes
                Statistics: ['Average']
            });

            const memoryData = await cloudWatchClient.send(memoryCommand);
            const memoryDatapoints = memoryData.Datapoints || [];
            memoryAverage = calculateAverage(memoryDatapoints);

            logger.info(`[Realtime Metrics] Memory: ${memoryDatapoints.length} datapoints, average: ${memoryAverage}%`);
        } catch (memError) {
            // Memory metrics not available - CloudWatch Agent not installed
            logger.info(`[Realtime Metrics] Memory metrics not available for ${instanceId} (CloudWatch Agent not installed)`);
        }

        return {
            cpu: cpuAverage !== null ? cpuAverage : 0,
            memory: memoryAverage,
            datapoints: {
                cpu: cpuDatapoints.length,
                memory: memoryAverage !== null ? 1 : 0
            }
        };
    } catch (error) {
        logger.error(`[Realtime Metrics] Failed to fetch metrics for ${instanceId}:`, error.message);
        throw error;
    }
};

/**
 * Fetch EC2 instance recommendations from AWS Compute Optimizer
 * @param {Object} credentials - AWS credentials
 * @param {string} region - AWS region (Compute Optimizer requires us-east-1)
 * @param {Array} instanceArns - Optional array of instance ARNs to filter
 * @returns {Array} Array of recommendation objects with ALL options
 */
/**
 * Helper function to construct proper instance ARN with account ID
 * @param {string} input - Instance ID or partial ARN
 * @param {string} region - AWS region
 * @param {string} accountId - AWS account ID
 * @returns {string} Full instance ARN
 */
const constructInstanceArn = (input, region, accountId) => {
    // If input is already a valid full ARN with account ID, return as-is
    if (input.startsWith('arn:aws:ec2:') && !input.includes('::')) {
        return input;
    }

    // If input is a partial ARN with missing account ID (::), inject account ID
    if (input.startsWith('arn:aws:ec2:') && input.includes('::')) {
        return input.replace('::', `:${accountId}:`);
    }

    // If input is just an instance ID (i-*), construct full ARN
    if (input.startsWith('i-')) {
        return `arn:aws:ec2:${region}:${accountId}:instance/${input}`;
    }

    // Fallback: assume it's an instance ID
    return `arn:aws:ec2:${region}:${accountId}:instance/${input}`;
};

const fetchComputeOptimizerRecommendations = async (credentials, region = 'us-east-1', instanceArns = null) => {
    try {
        logger.info(`[Compute Optimizer] Fetching EC2 recommendations for region ${region}`);

        // STEP 1: Retrieve AWS account ID using STS GetCallerIdentity
        let accountId;
        try {
            const stsClient = new STSClient({
                region: region, // Use the same region as the instance for consistency
                credentials: {
                    accessKeyId: credentials.accessKeyId,
                    secretAccessKey: credentials.secretAccessKey
                }
            });

            const identityCommand = new GetCallerIdentityCommand({});
            const identityResponse = await stsClient.send(identityCommand);
            accountId = identityResponse.Account;

            logger.info(`[Compute Optimizer] Using AWS Account ID: ${accountId}`);
        } catch (stsError) {
            // If STS fails, log the error but continue without account ID
            logger.error(`[Compute Optimizer] Failed to retrieve account ID:`, stsError.message);
            logger.warn(`[Compute Optimizer] Continuing without account ID - will fetch all recommendations`);
            accountId = null;
        }

        // STEP 2: Construct proper instance ARNs if account ID was retrieved
        let constructedArns = instanceArns;
        if (accountId && instanceArns) {
            constructedArns = instanceArns.map(arn => constructInstanceArn(arn, region, accountId));
            logger.info(`[Compute Optimizer] Constructed ARNs: ${JSON.stringify(constructedArns)}`);
        }

        // Compute Optimizer client - use the instance's region for regional recommendations
        // NOTE: While Compute Optimizer is a global service, using the instance's region
        // returns better results for region-specific instances
        const computeOptimizerClient = new ComputeOptimizerClient({
            region: region, // Use the instance's region, not us-east-1
            credentials: {
                accessKeyId: credentials.accessKeyId,
                secretAccessKey: credentials.secretAccessKey
            }
        });

        logger.info(`[Compute Optimizer] Using region: ${region} for Compute Optimizer client`);

        // STEP 3: Build command parameters
        const commandParams = {
            maxResults: 100 // Maximum allowed by AWS
        };

        // If we have constructed ARNs, use them
        if (constructedArns) {
            commandParams.instanceArns = constructedArns;
            logger.info(`[Compute Optimizer] Using instance ARNs filter`);
        } else if (accountId) {
            // If no specific instances requested but we have account ID, use accountIds filter
            commandParams.accountIds = [accountId];
            logger.info(`[Compute Optimizer] Using accountIds filter: [${accountId}]`);
        } else {
            // No filters - fetch all recommendations the credentials have access to
            logger.info(`[Compute Optimizer] Fetching all recommendations (no filters)`);
        }

        const command = new GetEC2InstanceRecommendationsCommand(commandParams);

        const response = await computeOptimizerClient.send(command);
        const recommendations = response.instanceRecommendations || [];

        // LOG EVERYTHING AWS RETURNS
        logger.info(`[Compute Optimizer] ========== RAW AWS RESPONSE ==========`);
        logger.info(`[Compute Optimizer] Found ${recommendations.length} recommendations`);
        logger.info(`[Compute Optimizer] Full response:`, JSON.stringify(response, null, 2));

        if (recommendations.length > 0) {
            logger.info(`[Compute Optimizer] ========== DETAILED RECOMMENDATIONS ==========`);
            recommendations.forEach((rec, idx) => {
                const instanceId = rec.instanceArn?.split('/').pop() || '';
                logger.info(`[Compute Optimizer] Recommendation ${idx + 1}:`);
                logger.info(`  - Instance ID: ${instanceId}`);
                logger.info(`  - Instance ARN: ${rec.instanceArn}`);
                logger.info(`  - Current Type: ${rec.currentInstanceType}`);
                logger.info(`  - Finding: ${rec.finding}`);
                logger.info(`  - Finding Reasons: ${JSON.stringify(rec.findingReasonCodes)}`);
                logger.info(`  - Lookback Period: ${rec.lookBackPeriodInDays} days`);
                logger.info(`  - Current Performance Risk: ${rec.currentPerformanceRisk}`);
                logger.info(`  - Utilization Metrics:`, JSON.stringify(rec.utilizationMetrics));
                logger.info(`  - Recommendation Options (${rec.recommendationOptions?.length || 0}):`);
                rec.recommendationOptions?.forEach((opt, optIdx) => {
                    logger.info(`    Option ${optIdx + 1}:`);
                    logger.info(`      - Instance Type: ${opt.instanceType}`);
                    logger.info(`      - Performance Risk: ${opt.performanceRisk}`);
                    logger.info(`      - Rank: ${opt.rank}`);
                    logger.info(`      - Migration Effort: ${opt.migrationEffort}`);
                    logger.info(`      - Projected Utilization:`, JSON.stringify(opt.projectedUtilizationMetrics));
                    logger.info(`      - Savings Opportunity:`, JSON.stringify(opt.savingsOpportunity));
                    logger.info(`      - Platform Differences:`, JSON.stringify(opt.platformDifferences));
                });
                logger.info(`[Compute Optimizer] ==========================================`);
            });
        } else {
            logger.warn(`[Compute Optimizer] ⚠️ NO RECOMMENDATIONS RETURNED BY AWS`);
            logger.warn(`[Compute Optimizer] Possible reasons:`);
            logger.warn(`  1. Compute Optimizer not enabled (opt-in required)`);
            logger.warn(`  2. No instances have 14+ days of metrics`);
            logger.warn(`  3. Instances are in unsupported regions`);
            logger.warn(`  4. Account has no EC2 instances`);
        }

        // Transform AWS Compute Optimizer response to application format
        const transformedRecommendations = recommendations.map(rec => {
            // Extract instance ID from ARN (arn:aws:ec2:region:account:instance/i-xxxxx)
            const instanceId = rec.instanceArn?.split('/').pop() || '';

            // Get current utilization metrics
            const currentCpuUtil = rec.utilizationMetrics?.find(m => m.name === 'CPU')?.value || null;
            const currentMemUtil = rec.utilizationMetrics?.find(m => m.name === 'MEMORY')?.value || null;

            // Transform ALL recommendation options (not just the first one)
            const allOptions = (rec.recommendationOptions || []).map((option, index) => {
                // Extract projected utilization metrics
                const cpuProjected = option.projectedUtilizationMetrics?.find(m => m.name === 'CPU')?.value || null;
                const memoryProjected = option.projectedUtilizationMetrics?.find(m => m.name === 'MEMORY')?.value || null;

                // Extract pricing information
                const savingsOpportunity = option.savingsOpportunity || {};
                const estimatedMonthlySavings = savingsOpportunity.estimatedMonthlySavings?.value || 0;
                const savingsPercentage = savingsOpportunity.savingsOpportunityPercentage?.value || 0;

                // Extract platform differences
                const platformDifferences = option.platformDifferences || [];

                // COST CALCULATION FIX: Extract hourly rate from savings opportunity
                // AWS doesn't directly provide hourly rates, but we can calculate them from savings
                // The savings represent: current_cost - recommended_cost
                // So: recommended_hourly_rate = current_hourly_rate - (monthly_savings / 730)
                // We'll calculate this after we determine the current hourly rate
                let recommendedHourlyRate = null;

                return {
                    option_number: index + 1,
                    instance_type: option.instanceType,
                    performance_risk: option.performanceRisk || 0,
                    rank: option.rank || (index + 1),
                    cpu_projected: cpuProjected,
                    memory_projected: memoryProjected,
                    estimated_monthly_savings: estimatedMonthlySavings,
                    savings_percentage: savingsPercentage,
                    platform_differences: platformDifferences,
                    migration_effort: option.migrationEffort || 'VeryLow',
                    // Store savings opportunity for later hourly rate calculation
                    _savingsOpportunity: savingsOpportunity
                };
            });

            // COST CALCULATION FIX: Use actual EC2 pricing with region multipliers
            // Instead of calculating from savings percentages (which creates circular dependencies),
            // we use the getEstimatedHourlyCost() function which has region-specific pricing

            const extractedRegion = rec.instanceArn?.split(':')[3] || region;

            // Calculate current instance cost using pricing map + region multiplier
            const currentInstanceType = rec.currentInstanceType;
            const currentHourlyRate = getEstimatedHourlyCost(currentInstanceType, extractedRegion);
            const currentMonthlyCost = currentHourlyRate * 730;

            logger.info(`[Compute Optimizer] Cost calculation for ${instanceId}:`);
            logger.info(`  - Current instance: ${currentInstanceType}`);
            logger.info(`  - Region: ${extractedRegion}`);
            logger.info(`  - Current hourly rate: $${currentHourlyRate.toFixed(4)}/hour`);
            logger.info(`  - Current monthly cost: $${currentMonthlyCost.toFixed(2)}/month`);

            // Calculate costs for each recommendation option using actual pricing
            allOptions.forEach((option, idx) => {
                // Get the hourly rate for this specific instance type in this region
                const optionHourlyRate = getEstimatedHourlyCost(option.instance_type, extractedRegion);
                const optionMonthlyCost = optionHourlyRate * 730;

                // Calculate actual savings based on price difference
                const actualMonthlySavings = currentMonthlyCost - optionMonthlyCost;
                const actualSavingsPercentage = (actualMonthlySavings / currentMonthlyCost) * 100;

                option.monthly_cost = optionMonthlyCost;
                option.hourly_rate = optionHourlyRate;

                // Override AWS savings with our calculated savings (more accurate)
                option.estimated_monthly_savings = actualMonthlySavings;
                option.savings_percentage = actualSavingsPercentage;

                logger.info(`  - Option ${idx + 1} (${option.instance_type}):`);
                logger.info(`    - Hourly rate: $${optionHourlyRate.toFixed(4)}/hour`);
                logger.info(`    - Monthly cost: $${optionMonthlyCost.toFixed(2)}/month`);
                logger.info(`    - Savings: $${actualMonthlySavings.toFixed(2)}/month (${actualSavingsPercentage.toFixed(1)}%)`);

                // Remove temporary field
                delete option._savingsOpportunity;
            });

            // Get the best recommendation option (first one is usually the best)
            const bestOption = allOptions[0] || {};

            // Map finding to recommendation text
            let recommendation = 'No recommendations available';
            const transformedFinding = transformComputeOptimizerFinding(rec.finding);

            if (transformedFinding === 'Underprovisioned') {
                recommendation = 'Upgrade instance type';
            } else if (transformedFinding === 'Overprovisioned') {
                recommendation = 'Downsize instance to reduce cost';
            } else if (transformedFinding === 'Optimized') {
                recommendation = 'Instance is optimized';
            }

            return {
                instance_id: instanceId,
                instance_name: rec.instanceName || instanceId,
                instance_arn: rec.instanceArn,
                provider: 'AWS',
                region: rec.instanceArn?.split(':')[3] || region, // Extract region from ARN
                current_instance_type: rec.currentInstanceType,
                finding: transformedFinding || 'NotAvailable',
                finding_reasons: rec.findingReasonCodes || [],

                // Current utilization
                current_cpu_utilization: currentCpuUtil,
                current_memory_utilization: currentMemUtil,

                // COST CALCULATION FIX: Add current cost fields
                current_monthly_cost: currentMonthlyCost,
                current_hourly_rate: currentHourlyRate,

                // Best recommendation (for backward compatibility)
                recommended_instance_type: bestOption.instance_type || null,
                performance_risk: bestOption.performance_risk || null,
                cpu_projected_utilization: bestOption.cpu_projected,
                memory_projected_utilization: bestOption.memory_projected,
                estimated_monthly_savings: bestOption.estimated_monthly_savings || 0,

                // ALL recommendation options (now includes monthly_cost and hourly_rate)
                recommendation_options: allOptions,

                recommendation: recommendation,
                last_refresh_timestamp: rec.lastRefreshTimestamp,
                look_back_period_in_days: rec.lookBackPeriodInDays || 14,

                // Additional metadata
                current_performance_risk: rec.currentPerformanceRisk || 'VeryLow',
                effective_recommendation_preferences: rec.effectiveRecommendationPreferences || {},
                inferred_workload_types: rec.inferredWorkloadTypes || []
            };
        });

        return transformedRecommendations;

    } catch (error) {
        logger.error(`[Compute Optimizer] Failed to fetch recommendations:`, error.message);

        // Handle specific AWS errors
        if (error.name === 'OptInRequiredException') {
            logger.warn(`[Compute Optimizer] AWS Compute Optimizer is not enabled for this account`);
            return [];
        }

        if (error.name === 'AccessDeniedException') {
            logger.warn(`[Compute Optimizer] Access denied - missing compute-optimizer:GetEC2InstanceRecommendations permission`);
            return [];
        }

        throw error;
    }
};


/**
 * Detect OS from AWS EC2 instance
 * AUTHORITATIVE METHOD: Uses PlatformDetails first, then falls back to AMI lookup
 * Returns: { os_type: 'Linux'|'Windows'|'unknown', os_source: 'cloud'|'inferred'|'unresolved', os_confidence: 'high'|'medium'|'low' }
 */
const detectAWSOS = async (ec2Client, instance) => {
    try {
        logger.info(`[OS Detection] Starting for instance ${instance.InstanceId}`);
        logger.info(`[OS Detection] PlatformDetails: ${instance.PlatformDetails || 'NOT AVAILABLE'}`);
        logger.info(`[OS Detection] Platform: ${instance.Platform || 'NOT AVAILABLE'}`);
        logger.info(`[OS Detection] ImageId: ${instance.ImageId || 'NOT AVAILABLE'}`);

        // Step A: Check PlatformDetails (AUTHORITATIVE)
        if (instance.PlatformDetails) {
            const platformDetails = instance.PlatformDetails.toLowerCase();
            logger.info(`[OS Detection] Checking PlatformDetails: "${platformDetails}"`);

            if (platformDetails.includes('windows')) {
                logger.info(`[OS Detection] ✅ OS detected from PlatformDetails: Windows (${instance.PlatformDetails})`);
                return { os_type: 'Windows', os_source: 'cloud', os_confidence: 'high' };
            }

            // All Linux variants
            if (platformDetails.includes('linux') ||
                platformDetails.includes('red hat') ||
                platformDetails.includes('suse') ||
                platformDetails.includes('ubuntu')) {
                logger.info(`[OS Detection] ✅ OS detected from PlatformDetails: Linux (${instance.PlatformDetails})`);
                return { os_type: 'Linux', os_source: 'cloud', os_confidence: 'high' };
            }

            logger.warn(`[OS Detection] PlatformDetails present but no OS match: "${platformDetails}"`);
        } else {
            logger.warn(`[OS Detection] PlatformDetails NOT available for ${instance.InstanceId}`);
        }

        // Step B: Fallback to Platform field (legacy)
        if (instance.Platform) {
            const platform = instance.Platform.toLowerCase();
            logger.info(`[OS Detection] Checking Platform field: "${platform}"`);
            if (platform === 'windows') {
                logger.info(`[OS Detection] ✅ OS detected from Platform field: Windows`);
                return { os_type: 'Windows', os_source: 'cloud', os_confidence: 'high' };
            }
        } else {
            logger.info(`[OS Detection] Platform field NOT available`);
        }

        // Step C: Fallback to AMI lookup (requires DescribeImages permission)
        if (instance.ImageId) {
            logger.info(`[OS Detection] Attempting AMI lookup for ${instance.ImageId}`);
            try {
                const imageCommand = new DescribeImagesCommand({
                    ImageIds: [instance.ImageId]
                });
                const imageData = await ec2Client.send(imageCommand);

                if (imageData.Images && imageData.Images.length > 0) {
                    const image = imageData.Images[0];
                    logger.info(`[OS Detection] AMI found - Name: ${image.Name}, Platform: ${image.Platform || 'none'}, Description: ${image.Description || 'none'}`);

                    // Check Platform field in AMI
                    if (image.Platform && image.Platform.toLowerCase() === 'windows') {
                        logger.info(`[OS Detection] ✅ OS detected from AMI Platform: Windows`);
                        return { os_type: 'Windows', os_source: 'cloud', os_confidence: 'medium' };
                    }

                    // Check Description for OS hints
                    const description = (image.Description || '').toLowerCase();
                    const name = (image.Name || '').toLowerCase();
                    const combined = description + ' ' + name;

                    if (combined.includes('windows')) {
                        logger.info(`[OS Detection] ✅ OS inferred from AMI description: Windows`);
                        return { os_type: 'Windows', os_source: 'inferred', os_confidence: 'medium' };
                    }

                    if (combined.includes('linux') || combined.includes('ubuntu') ||
                        combined.includes('rhel') || combined.includes('amazon') ||
                        combined.includes('centos') || combined.includes('debian')) {
                        logger.info(`[OS Detection] ✅ OS inferred from AMI description: Linux`);
                        return { os_type: 'Linux', os_source: 'inferred', os_confidence: 'medium' };
                    }

                    logger.warn(`[OS Detection] AMI found but no OS match in name/description`);
                } else {
                    logger.warn(`[OS Detection] AMI ${instance.ImageId} not found in DescribeImages response`);
                }
            } catch (amiError) {
                logger.error(`[OS Detection] Failed to fetch AMI details for ${instance.ImageId}: ${amiError.message}`);
                // Continue to unresolved
            }
        }

        // If no PlatformDetails and no Platform field, assume Linux (most common)
        logger.warn(`[OS Detection] ⚠️ OS could not be determined for instance ${instance.InstanceId}, defaulting to Linux`);
        return { os_type: 'Linux', os_source: 'inferred', os_confidence: 'low' };

    } catch (error) {
        logger.error(`[OS Detection] ❌ OS detection failed for instance ${instance.InstanceId}: ${error.message}`);
        return { os_type: 'unknown', os_source: 'unresolved', os_confidence: 'low' };
    }
};

/**
 * Fetch real instance type specifications from AWS API
 * Returns actual vCPU and memory from AWS, not from lookup table
 * ENHANCED: Detects burstable instances (T-series), tracks architecture, logs unknown types
 */
const getEc2SpecsFromAWS = async (ec2Client, instanceType) => {
    try {
        const command = new DescribeInstanceTypesCommand({
            InstanceTypes: [instanceType]
        });

        const response = await ec2Client.send(command);

        if (response.InstanceTypes && response.InstanceTypes.length > 0) {
            const instanceTypeInfo = response.InstanceTypes[0];
            const vCpu = instanceTypeInfo.VCpuInfo?.DefaultVCpus || null;
            const memoryMiB = instanceTypeInfo.MemoryInfo?.SizeInMiB || null;
            const memoryGb = memoryMiB ? memoryMiB / 1024 : null; // NO ROUNDING - exact value

            // Detect burstable instances (T-series)
            const burstable = instanceType.startsWith('t2.') ||
                instanceType.startsWith('t3.') ||
                instanceType.startsWith('t3a.') ||
                instanceType.startsWith('t4g.');

            // Detect architecture
            const processorInfo = instanceTypeInfo.ProcessorInfo;
            const architecture = processorInfo?.SupportedArchitectures?.[0] || 'x86_64';

            // Detect GPU
            const gpu = instanceTypeInfo.GpuInfo?.Gpus?.length > 0;

            logger.info(`[AWS Specs] ${instanceType}: ${vCpu} vCPU, ${memoryGb} GB RAM, arch=${architecture}, burstable=${burstable}, gpu=${gpu} (from AWS API)`);

            return {
                vCpu: vCpu,
                memoryGb: memoryGb,
                architecture: architecture,
                burstable: burstable,
                gpu: gpu
            };
        }

        logger.warn(`[AWS Specs] No data returned for ${instanceType}, marking as unresolvable`);

        // Track unknown instance type in database for future updates
        await trackUnresolvableInstance('aws', instanceType, 'unknown');

        return { vCpu: null, memoryGb: null, architecture: null, burstable: false, gpu: false };

    } catch (error) {
        logger.error(`[AWS Specs] Failed to fetch specs for ${instanceType}: ${error.message}`);

        // Track unknown instance type in database
        await trackUnresolvableInstance('aws', instanceType, 'unknown');

        return { vCpu: null, memoryGb: null, architecture: null, burstable: false, gpu: false };
    }
};

// Spec Helper (Moved from cloudService)
const getEc2Specs = (type) => {
    logger.warn(`[AWS Specs] No specs available for ${type} - returning NULL`);
    return { vCpu: null, memoryGb: null };
};

/**
 * Get estimated hourly cost for AWS EC2 instance type
 * This is a simplified pricing model - actual costs vary by region, OS, and usage
 * Prices are approximate On-Demand rates for Linux in us-east-1
 */
const getEstimatedHourlyCost = (instanceType, region = 'us-east-1') => {
    // Basic pricing map for common instance types (On-Demand Linux/Unix in us-east-1)
    const pricingMap = {
        // T2 instances (burstable)
        't2.nano': 0.0058,
        't2.micro': 0.0116,
        't2.small': 0.023,
        't2.medium': 0.0464,
        't2.large': 0.0928,
        't2.xlarge': 0.1856,
        't2.2xlarge': 0.3712,

        // T3 instances (burstable, newer generation)
        't3.nano': 0.0052,
        't3.micro': 0.0104,
        't3.small': 0.0208,
        't3.medium': 0.0416,
        't3.large': 0.0832,
        't3.xlarge': 0.1664,
        't3.2xlarge': 0.3328,

        // T4g instances (ARM-based, burstable)
        't4g.nano': 0.0042,
        't4g.micro': 0.0084,
        't4g.small': 0.0168,
        't4g.medium': 0.0336,
        't4g.large': 0.0672,
        't4g.xlarge': 0.1344,
        't4g.2xlarge': 0.2688,

        // M5 instances (general purpose)
        'm5.large': 0.096,
        'm5.xlarge': 0.192,
        'm5.2xlarge': 0.384,
        'm5.4xlarge': 0.768,
        'm5.8xlarge': 1.536,
        'm5.12xlarge': 2.304,
        'm5.16xlarge': 3.072,
        'm5.24xlarge': 4.608,

        // M6i instances (general purpose, newer)
        'm6i.large': 0.096,
        'm6i.xlarge': 0.192,
        'm6i.2xlarge': 0.384,
        'm6i.4xlarge': 0.768,
        'm6i.8xlarge': 1.536,

        // C5 instances (compute optimized)
        'c5.large': 0.085,
        'c5.xlarge': 0.17,
        'c5.2xlarge': 0.34,
        'c5.4xlarge': 0.68,
        'c5.9xlarge': 1.53,
        'c5.12xlarge': 2.04,
        'c5.18xlarge': 3.06,
        'c5.24xlarge': 4.08,

        // R5 instances (memory optimized)
        'r5.large': 0.126,
        'r5.xlarge': 0.252,
        'r5.2xlarge': 0.504,
        'r5.4xlarge': 1.008,
        'r5.8xlarge': 2.016,
        'r5.12xlarge': 3.024,
        'r5.16xlarge': 4.032,
        'r5.24xlarge': 6.048
    };

    // Region pricing multipliers (relative to us-east-1)
    // Based on AWS EC2 On-Demand pricing differences across regions
    const regionMultipliers = {
        'us-east-1': 1.0,      // N. Virginia (baseline)
        'us-east-2': 1.0,      // Ohio
        'us-west-1': 1.15,     // N. California
        'us-west-2': 1.0,      // Oregon
        'ca-central-1': 1.05,  // Canada
        'eu-west-1': 1.10,     // Ireland
        'eu-west-2': 1.12,     // London
        'eu-west-3': 1.12,     // Paris
        'eu-central-1': 1.10,  // Frankfurt
        'eu-north-1': 1.05,    // Stockholm
        'ap-south-1': 1.08,    // Mumbai
        'ap-northeast-1': 1.15, // Tokyo
        'ap-northeast-2': 1.10, // Seoul
        'ap-northeast-3': 1.15, // Osaka
        'ap-southeast-1': 1.22, // Singapore (CRITICAL FIX: was missing, now matches AWS pricing)
        'ap-southeast-2': 1.20, // Sydney
        'sa-east-1': 1.50,     // São Paulo
        'me-south-1': 1.20,    // Bahrain
        'af-south-1': 1.25     // Cape Town
    };

    const basePrice = pricingMap[instanceType];
    const regionMultiplier = regionMultipliers[region] || 1.0;

    if (basePrice) {
        const adjustedPrice = basePrice * regionMultiplier;
        logger.info(`[AWS Pricing] ${instanceType} in ${region}: $${adjustedPrice.toFixed(4)}/hour (base: $${basePrice.toFixed(4)}, multiplier: ${regionMultiplier}x)`);
        return adjustedPrice;
    }

    // If not in map, estimate based on instance family and size
    const match = instanceType.match(/^([a-z]+\d+[a-z]*)\.(\w+)$/);
    if (match) {
        const [, family, size] = match;

        // Size multipliers
        const sizeMultipliers = {
            'nano': 0.25,
            'micro': 0.5,
            'small': 1,
            'medium': 2,
            'large': 4,
            'xlarge': 8,
            '2xlarge': 16,
            '4xlarge': 32,
            '8xlarge': 64,
            '12xlarge': 96,
            '16xlarge': 128,
            '24xlarge': 192,
            '32xlarge': 256
        };

        // Base prices by family (for 'large' size)
        const familyBasePrices = {
            't2': 0.0928,
            't3': 0.0832,
            't3a': 0.0748,
            't4g': 0.0672,
            'm5': 0.096,
            'm5a': 0.086,
            'm5n': 0.119,
            'm6i': 0.096,
            'm6a': 0.0864,
            'm6g': 0.077,
            'c5': 0.085,
            'c5a': 0.077,
            'c5n': 0.108,
            'c6i': 0.085,
            'c6a': 0.0765,
            'c6g': 0.068,
            'r5': 0.126,
            'r5a': 0.113,
            'r5n': 0.149,
            'r6i': 0.126,
            'r6a': 0.1134,
            'r6g': 0.1008
        };

        const basePrice = familyBasePrices[family] || 0.10; // Default to $0.10/hour for unknown families
        const multiplier = sizeMultipliers[size] || 4; // Default to 'large' multiplier

        const estimatedPrice = ((basePrice / 4) * multiplier) * regionMultiplier; // Apply region multiplier
        logger.info(`[AWS Pricing] ${instanceType} in ${region}: $${estimatedPrice.toFixed(4)}/hour (estimated from family ${family}, multiplier: ${regionMultiplier}x)`);
        return estimatedPrice;
    }

    // Fallback: return a default price with region multiplier
    const fallbackPrice = 0.10 * regionMultiplier;
    logger.warn(`[AWS Pricing] Unknown instance type ${instanceType} in ${region}, using default $${fallbackPrice.toFixed(4)}/hour`);
    return fallbackPrice;
};


/**
 * Fetch CloudWatch metrics for an EC2 instance
 * Returns average and p95 CPU and memory utilization
 * ENHANCED: Agent detection, 14-day window, running hours calculation, missing metrics tracking
 */
/**
 * Fetch CloudWatch metrics for an EC2 instance
 * Returns average and p95 CPU and memory utilization
 * ENHANCED: State-aware fetching, agent detection, time window validation, running hours calculation
 *
 * @param {Object} cloudWatchClient - AWS CloudWatch client
 * @param {string} instanceId - EC2 instance ID
 * @param {string} region - AWS region
 * @param {string} state - Instance state (running, stopped, terminated, etc.)
 * @returns {Object} Normalized metrics with status indicators
 */
const fetchCloudWatchMetrics = async (cloudWatchClient, instanceId, region, state = 'unknown') => {
    const METRICS_WINDOW_DAYS = parseInt(process.env.METRICS_WINDOW_DAYS) || 30;

    // CRITICAL: Determine instance state FIRST before fetching metrics
    // Requirement 1.1: State Detection Precedes Metrics Collection
    logger.info(`[Metrics] Instance ${instanceId} state: ${state}`);

    // CRITICAL: Return early with null metrics if instance is not running
    // Requirement 1.2: Stopped Instances Return Null Metrics
    if (state !== 'running') {
        logger.info(`[Metrics] Skipping metrics for ${instanceId} - instance is ${state} (not running)`);
        return {
            cpu_avg: null,
            cpu_p95: null,
            memory_avg: null,
            memory_p95: null,
            cpu_credit_balance: null,
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

    // Instance is running - proceed with metrics collection
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - METRICS_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    logger.info(`[Metrics] Fetching CloudWatch metrics for ${instanceId} (${METRICS_WINDOW_DAYS}-day window)`);

    let metrics_status = 'missing';
    let memory_metrics_source = 'unavailable';
    let missing_metrics = [];
    let cpu_avg = null;
    let cpu_p95 = null;
    let memory_avg = null;
    let memory_p95 = null;
    let cpu_credit_balance = null;
    let running_hours_last_14d = 0;

    try {
        // CPU Utilization - CRITICAL: Must fetch from AWS/EC2
        const cpuCommand = new GetMetricStatisticsCommand({
            Namespace: 'AWS/EC2',
            MetricName: 'CPUUtilization',
            Dimensions: [{ Name: 'InstanceId', Value: instanceId }],
            StartTime: startTime,
            EndTime: endTime,
            Period: 3600, // 1 hour
            Statistics: ['Average']
        });

        const cpuData = await cloudWatchClient.send(cpuCommand);
        const cpuDatapoints = cpuData.Datapoints || [];

        if (cpuDatapoints.length > 0) {
            // Calculate average from all datapoints
            cpu_avg = cpuDatapoints.reduce((sum, dp) => sum + (dp.Average || 0), 0) / cpuDatapoints.length;

            // Calculate p95 manually from datapoints
            const cpuValues = cpuDatapoints.map(dp => dp.Average || 0).sort((a, b) => a - b);
            const p95Index = Math.floor(cpuValues.length * 0.95);
            cpu_p95 = cpuValues[p95Index] || cpu_avg * 1.2;

            // Calculate running hours from number of datapoints (each datapoint = 1 hour)
            running_hours_last_14d = cpuDatapoints.length;

            metrics_status = 'partial'; // CPU present, memory unknown

            logger.info(`CloudWatch CPU metrics for ${instanceId}: avg=${cpu_avg.toFixed(2)}%, p95=${cpu_p95.toFixed(2)}%, running_hours=${running_hours_last_14d}`);
        } else {
            logger.warn(`No CloudWatch CPU datapoints for ${instanceId} - instance may be newly launched or metrics not yet available`);
            missing_metrics.push('cpu_avg', 'cpu_p95');
        }

        // CPU Credit Balance (for burstable instances like T-series)
        try {
            const creditCommand = new GetMetricStatisticsCommand({
                Namespace: 'AWS/EC2',
                MetricName: 'CPUCreditBalance',
                Dimensions: [{ Name: 'InstanceId', Value: instanceId }],
                StartTime: startTime,
                EndTime: endTime,
                Period: 3600,
                Statistics: ['Average']
            });

            const creditData = await cloudWatchClient.send(creditCommand);
            const creditDatapoints = creditData.Datapoints || [];

            if (creditDatapoints.length > 0) {
                // Get the most recent credit balance
                const sortedCredits = creditDatapoints.sort((a, b) => b.Timestamp - a.Timestamp);
                cpu_credit_balance = sortedCredits[0].Average;
                logger.info(`CPU credit balance for ${instanceId}: ${cpu_credit_balance.toFixed(2)}`);
            }
        } catch (creditError) {
            // Credit balance not available - this is normal for non-burstable instances
            logger.debug(`CPU credit balance not available for ${instanceId} (expected for non-T-series instances)`);
        }

        // Memory metrics (optional - requires CloudWatch agent)
        try {
            const memCommand = new GetMetricStatisticsCommand({
                Namespace: 'CWAgent',
                MetricName: 'mem_used_percent',
                Dimensions: [{ Name: 'InstanceId', Value: instanceId }],
                StartTime: startTime,
                EndTime: endTime,
                Period: 3600,
                Statistics: ['Average']
            });

            const memData = await cloudWatchClient.send(memCommand);
            const memDatapoints = memData.Datapoints || [];

            if (memDatapoints.length > 0) {
                memory_avg = memDatapoints.reduce((sum, dp) => sum + (dp.Average || 0), 0) / memDatapoints.length;

                // Calculate p95 manually
                const memValues = memDatapoints.map(dp => dp.Average || 0).sort((a, b) => a - b);
                const p95Index = Math.floor(memValues.length * 0.95);
                memory_p95 = memValues[p95Index] || memory_avg * 1.2;

                memory_metrics_source = 'available';

                if (cpu_avg !== null) {
                    metrics_status = 'complete'; // Both CPU and memory present
                }

                logger.info(`CloudWatch memory metrics for ${instanceId}: avg=${memory_avg.toFixed(2)}%, p95=${memory_p95.toFixed(2)}%`);
            } else {
                logger.info(`No memory metrics for ${instanceId} - CloudWatch agent not installed (this is normal)`);
                memory_metrics_source = 'agent_required';
                missing_metrics.push('memory_avg', 'memory_p95');
            }
        } catch (memError) {
            // Memory metrics not available - this is EXPECTED and NORMAL
            logger.info(`Memory metrics not available for ${instanceId} - CloudWatch agent not installed (expected)`);
            memory_metrics_source = 'agent_required';
            missing_metrics.push('memory_avg', 'memory_p95');
        }

        // Network metrics
        const networkInCommand = new GetMetricStatisticsCommand({
            Namespace: 'AWS/EC2',
            MetricName: 'NetworkIn',
            Dimensions: [{ Name: 'InstanceId', Value: instanceId }],
            StartTime: startTime,
            EndTime: endTime,
            Period: 3600,
            Statistics: ['Average']
        });

        const networkOutCommand = new GetMetricStatisticsCommand({
            Namespace: 'AWS/EC2',
            MetricName: 'NetworkOut',
            Dimensions: [{ Name: 'InstanceId', Value: instanceId }],
            StartTime: startTime,
            EndTime: endTime,
            Period: 3600,
            Statistics: ['Average']
        });

        const [networkInData, networkOutData] = await Promise.all([
            cloudWatchClient.send(networkInCommand),
            cloudWatchClient.send(networkOutCommand)
        ]);

        const networkInDatapoints = networkInData.Datapoints || [];
        const networkOutDatapoints = networkOutData.Datapoints || [];

        const network_in_bytes = networkInDatapoints.length > 0
            ? networkInDatapoints.reduce((sum, dp) => sum + (dp.Average || 0), 0) / networkInDatapoints.length
            : 0;

        const network_out_bytes = networkOutDatapoints.length > 0
            ? networkOutDatapoints.reduce((sum, dp) => sum + (dp.Average || 0), 0) / networkOutDatapoints.length
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
            cpu_credit_balance: cpu_credit_balance !== null ? Math.round(cpu_credit_balance * 10) / 10 : null,
            network_in_bytes: Math.round(network_in_bytes),
            network_out_bytes: Math.round(network_out_bytes),
            disk_read_iops: 0, // Would need EBS metrics
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
        logger.error(`Failed to fetch CloudWatch metrics for ${instanceId}:`, error.message);
        logger.error(`Error details:`, error);

        // Return null values if metrics fetch fails - DO NOT return fake data
        return {
            cpu_avg: null,
            cpu_p95: null,
            memory_avg: null,
            memory_p95: null,
            cpu_credit_balance: null,
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
}



/**
 * Test AWS connection and validate permissions
 * Returns detailed permission status with missing permissions and impact
 */
const testConnection = async (creds) => {
    if (!creds.accessKeyId || !creds.secretAccessKey) {
        throw new Error("Missing AWS Credentials");
    }

    const region = creds.region || "us-east-1";
    const credentials = {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey
    };

    // Test basic connectivity with STS - this will fail if credentials are deleted
    let identity;
    try {
        const stsClient = new STSClient({ region, credentials });
        const identityCommand = new GetCallerIdentityCommand({});
        identity = await stsClient.send(identityCommand);
        logger.info('[AWS Auth] ✓ Credentials are valid and can authenticate');
    } catch (authError) {
        logger.error('[AWS Auth] ✗ Authentication failed - credentials may be deleted or revoked');

        // Check if this is a credential error
        if (authError.name === 'InvalidClientTokenId' ||
            authError.name === 'SignatureDoesNotMatch' ||
            authError.name === 'UnrecognizedClientException' ||
            authError.message?.includes('security token') ||
            authError.message?.includes('credentials')) {
            throw new Error('AWS credentials are invalid or have been deleted from AWS IAM');
        }

        // Re-throw other errors
        throw authError;
    }

    // Test required permissions
    const missingPermissions = [];
    const impact = [];
    let connectionStatus = 'full';
    let hasAnyAccess = false;

    // Test ec2:DescribeInstances
    try {
        const ec2Client = new EC2Client({ region, credentials });
        await ec2Client.send(new DescribeInstancesCommand({ MaxResults: 5 }));
        hasAnyAccess = true;
        logger.info('[AWS Permissions] ✓ ec2:DescribeInstances available');
    } catch (error) {
        if (error.name === 'UnauthorizedOperation' || error.name === 'AccessDenied') {
            missingPermissions.push('ec2:DescribeInstances');
            impact.push('Cannot fetch EC2 instance inventory');
            connectionStatus = 'partial';
            logger.warn('[AWS Permissions] ✗ ec2:DescribeInstances missing');
        }
    }

    // Test ec2:DescribeInstanceTypes
    try {
        const ec2Client = new EC2Client({ region, credentials });
        await ec2Client.send(new DescribeInstanceTypesCommand({ MaxResults: 1 }));
        hasAnyAccess = true;
        logger.info('[AWS Permissions] ✓ ec2:DescribeInstanceTypes available');
    } catch (error) {
        if (error.name === 'UnauthorizedOperation' || error.name === 'AccessDenied') {
            missingPermissions.push('ec2:DescribeInstanceTypes');
            impact.push('Cannot fetch instance hardware specifications');
            connectionStatus = 'partial';
            logger.warn('[AWS Permissions] ✗ ec2:DescribeInstanceTypes missing');
        }
    }

    // Test cloudwatch:GetMetricStatistics
    try {
        const cloudWatchClient = new CloudWatchClient({ region, credentials });
        const testMetricCommand = new GetMetricStatisticsCommand({
            Namespace: 'AWS/EC2',
            MetricName: 'CPUUtilization',
            StartTime: new Date(Date.now() - 3600000),
            EndTime: new Date(),
            Period: 3600,
            Statistics: ['Average']
        });
        await cloudWatchClient.send(testMetricCommand);
        hasAnyAccess = true;
        logger.info('[AWS Permissions] ✓ cloudwatch:GetMetricStatistics available');
    } catch (error) {
        if (error.name === 'AccessDenied') {
            missingPermissions.push('cloudwatch:GetMetricStatistics');
            impact.push('Cannot fetch CPU and memory metrics');
            connectionStatus = 'partial';
            logger.warn('[AWS Permissions] ✗ cloudwatch:GetMetricStatistics missing');
        }
    }

    // Test pricing:GetProducts (optional but recommended)
    try {
        const { PricingClient, GetProductsCommand } = require("@aws-sdk/client-pricing");
        const pricingClient = new PricingClient({ region: 'us-east-1', credentials }); // Pricing API only in us-east-1
        await pricingClient.send(new GetProductsCommand({
            ServiceCode: 'AmazonEC2',
            MaxResults: 1
        }));
        hasAnyAccess = true;
        logger.info('[AWS Permissions] ✓ pricing:GetProducts available');
    } catch (error) {
        if (error.name === 'AccessDeniedException' || error.name === 'AccessDenied') {
            missingPermissions.push('pricing:GetProducts');
            impact.push('Live pricing unavailable - will use cached pricing');
            connectionStatus = 'partial';
            logger.warn('[AWS Permissions] ✗ pricing:GetProducts missing');
        }
    }

    // If no APIs are accessible, credentials may have no permissions
    if (!hasAnyAccess && missingPermissions.length > 0) {
        logger.warn(`⚠️  No AWS APIs accessible - credentials may have no permissions`);
        throw new Error('AWS credentials have no permissions. Please grant EC2, CloudWatch, or Pricing permissions.');
    }

    const message = connectionStatus === 'full'
        ? `Connected to AWS as ${identity.Arn} with full permissions`
        : `Connected to AWS as ${identity.Arn} with partial permissions`;

    return {
        success: true,
        message,
        connection_status: connectionStatus,
        missing_permissions: missingPermissions,
        impact,
        details: identity
    };
};

/**
 * Fetch AWS EC2 instances with CloudWatch metrics and analyze with ML
 */
const fetchResources = async (userId, creds) => {
    const instances = [];

    try {
        // Fetch all available regions for this account
        logger.info(`Fetching available AWS regions for user ${userId}`);
        const regionsResponse = await fetchAvailableRegions(creds);
        const availableRegions = regionsResponse.regions || [];
        const regionNames = availableRegions.map(r => r.regionName);
        logger.info(`Found ${regionNames.length} enabled regions: ${regionNames.join(', ')}`);

        // Loop through each region and fetch instances
        for (const regionName of regionNames) {
            logger.info(`\n${'='.repeat(80)}`);
            logger.info(`🌍 FETCHING RESOURCES FROM REGION: ${regionName}`);
            logger.info(`${'='.repeat(80)}\n`);

            try {
                const ec2Client = new EC2Client({
                    region: regionName,
                    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey }
                });

                const cloudWatchClient = new CloudWatchClient({
                    region: regionName,
                    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey }
                });

                const ec2Data = await ec2Client.send(new DescribeInstancesCommand({}));

                // Skip region if no instances - this speeds up scanning
                if (!ec2Data.Reservations || ec2Data.Reservations.length === 0) {
                    logger.info(`✅ Region ${regionName}: No instances found, skipping`);
                    continue;
                }

                // Collect ALL instances (running, stopped, idle, etc.) from this region
                for (const reservation of ec2Data.Reservations || []) {
                    for (const instance of reservation.Instances || []) {
                        // Process all instances regardless of state
                        const instanceState = instance.State.Name; // running, stopped, stopping, terminated, etc.

                        // Fetch real specs from AWS API
                        const specs = await getEc2SpecsFromAWS(ec2Client, instance.InstanceType);
                        const instanceName = instance.Tags?.find(t => t.Key === 'Name')?.Value || instance.InstanceId;

                        // Calculate estimated monthly cost based on instance type
                        const estimatedHourlyCost = getEstimatedHourlyCost(instance.InstanceType, regionName);
                        const estimatedMonthlyCost = estimatedHourlyCost * 730; // 730 hours per month average

                        // Detect OS using authoritative method
                        const osInfo = await detectAWSOS(ec2Client, instance);
                        logger.info(`Instance ${instanceName}: OS=${osInfo.os_type}, source=${osInfo.os_source}, confidence=${osInfo.os_confidence}`);

                        // Fetch CloudWatch metrics only for running instances
                        let metrics;
                        if (instanceState === 'running') {
                            logger.info(`Fetching metrics for AWS instance ${instanceName} (${instanceState})`);
                            metrics = await fetchCloudWatchMetrics(cloudWatchClient, instance.InstanceId, regionName, instanceState);
                        } else {
                            // For stopped/idle instances, set metrics to null (not zero)
                            logger.info(`Skipping metrics for AWS instance ${instanceName} (${instanceState})`);
                            metrics = {
                                cpu_avg: null,
                                cpu_p95: null,
                                memory_avg: null,
                                memory_p95: null,
                                cpu_credit_balance: null,
                                network_in_bytes: 0,
                                network_out_bytes: 0,
                                disk_read_iops: 0,
                                disk_write_iops: 0,
                                metrics_status: 'missing',
                                memory_metrics_source: 'unavailable',
                                missing_metrics: [],
                                running_hours_last_14d: 0
                            };
                        }

                        const instanceData = {
                            instance_id: instance.InstanceId,
                            instance_type: instance.InstanceType,
                            region: regionName,
                            cloud: 'aws',
                            state: instanceState, // Current real-time state from AWS
                            os: osInfo.os_type, // Use detected OS
                            os_source: osInfo.os_source,
                            os_confidence: osInfo.os_confidence,
                            vcpu_count: specs.vCpu,
                            ram_gb: specs.memoryGb,
                            architecture: specs.architecture,
                            burstable: specs.burstable,
                            gpu: specs.gpu,
                            cpu_avg: metrics.cpu_avg,
                            cpu_p95: metrics.cpu_p95,
                            memory_avg: metrics.memory_avg,
                            memory_p95: metrics.memory_p95,
                            cpu_credit_balance: metrics.cpu_credit_balance,
                            disk_read_iops: metrics.disk_read_iops,
                            disk_write_iops: metrics.disk_write_iops,
                            network_in_bytes: metrics.network_in_bytes,
                            network_out_bytes: metrics.network_out_bytes,
                            metrics_status: metrics.metrics_status,
                            memory_metrics_source: metrics.memory_metrics_source,
                            missing_metrics: metrics.missing_metrics,
                            running_hours_last_14d: metrics.running_hours_last_14d,
                            cost_per_month: estimatedMonthlyCost, // Use estimated cost from pricing map
                            source: 'cloud',
                            name: instanceName,
                            launch_time: instance.LaunchTime
                        };

                        // Log detailed instance information
                        logger.info(`\n${'='.repeat(80)}`);
                        logger.info(`📊 AWS INSTANCE DETAILS FETCHED`);
                        logger.info(`${'='.repeat(80)}`);
                        logger.info(`Instance Name: ${instanceName}`);
                        logger.info(`Instance ID: ${instance.InstanceId}`);
                        logger.info(`Instance Type: ${instance.InstanceType}`);
                        logger.info(`Region: ${regionName}`);
                        logger.info(`State: ${instanceState}`);
                        logger.info(`Launch Time: ${instance.LaunchTime}`);
                        logger.info(`\n--- Hardware Specifications ---`);
                        logger.info(`vCPU Count: ${specs.vCpu || 'N/A'}`);
                        logger.info(`RAM (GB): ${specs.memoryGb || 'N/A'}`);
                        logger.info(`Architecture: ${specs.architecture || 'N/A'}`);
                        logger.info(`Burstable: ${specs.burstable ? 'Yes (T-series)' : 'No'}`);
                        logger.info(`GPU: ${specs.gpu ? 'Yes' : 'No'}`);
                        logger.info(`\n--- Operating System ---`);
                        logger.info(`OS Type: ${osInfo.os_type}`);
                        logger.info(`OS Source: ${osInfo.os_source}`);
                        logger.info(`OS Confidence: ${osInfo.os_confidence}`);
                        logger.info(`\n--- Metrics (Last 14 Days) ---`);
                        logger.info(`CPU Average: ${metrics.cpu_avg !== null ? metrics.cpu_avg + '%' : 'N/A'}`);
                        logger.info(`CPU P95: ${metrics.cpu_p95 !== null ? metrics.cpu_p95 + '%' : 'N/A'}`);
                        logger.info(`Memory Average: ${metrics.memory_avg !== null ? metrics.memory_avg + '%' : 'N/A (Agent Required)'}`);
                        logger.info(`Memory P95: ${metrics.memory_p95 !== null ? metrics.memory_p95 + '%' : 'N/A (Agent Required)'}`);
                        logger.info(`CPU Credit Balance: ${metrics.cpu_credit_balance !== null ? metrics.cpu_credit_balance : 'N/A'}`);
                        logger.info(`Network In: ${metrics.network_in_bytes} bytes`);
                        logger.info(`Network Out: ${metrics.network_out_bytes} bytes`);
                        logger.info(`Running Hours (14d): ${metrics.running_hours_last_14d} hours`);
                        logger.info(`Metrics Status: ${metrics.metrics_status}`);
                        logger.info(`Memory Metrics Source: ${metrics.memory_metrics_source}`);
                        if (metrics.missing_metrics && metrics.missing_metrics.length > 0) {
                            logger.info(`Missing Metrics: ${metrics.missing_metrics.join(', ')}`);
                        }
                        logger.info(`${'='.repeat(80)}\n`);

                        instances.push(instanceData);
                    }
                }

                logger.info(`✅ Region ${regionName}: Collected ${ec2Data.Reservations?.length || 0} reservations`);

            } catch (regionError) {
                // Log region-specific errors but continue with other regions
                logger.error(`❌ Error fetching from region ${regionName}:`, regionError.message);
                logger.info(`Continuing with remaining regions...`);
            }
        }

        logger.info(`\n${'='.repeat(80)}`);
        logger.info(`✅ AWS MULTI-REGION FETCH SUMMARY`);
        logger.info(`${'='.repeat(80)}`);
        logger.info(`Total Instances Collected: ${instances.length}`);
        logger.info(`Regions Scanned: ${regionNames.length}`);
        logger.info(`User ID: ${userId}`);

        // Count by state
        const stateCount = {};
        instances.forEach(inst => {
            stateCount[inst.state] = (stateCount[inst.state] || 0) + 1;
        });
        logger.info(`\nInstances by State:`);
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

        logger.info(`${'='.repeat(80)}\n`);

        // Validate data before processing
        const validationResults = validateVMBatch(instances, 'aws');

        // Mark invalid VMs with errors
        const validatedInstances = instances.map(vm => {
            const validation = require('../utils/dataValidator').validateVMData(vm, 'aws');
            if (!validation.valid) {
                return markVMWithError(vm, validation.errors);
            }
            return vm;
        });

        // Normalize and enrich instances
        const normalizedVMs = validatedInstances.map(vm => normalizeVM(vm, 'cloud', { cloud: 'aws' }));
        const enrichedVMs = await enrichVMBatch(normalizedVMs);

        // Send to ML service for analysis (only for running instances with metrics)
        let mlResults = [];
        if (enrichedVMs.length > 0) {
            logger.info(`Sending ${enrichedVMs.length} AWS instances to ML service`);
            mlResults = await processVMsInBatches(enrichedVMs, 100);
            logger.info(`Received ${mlResults.length} predictions from ML service`);
        }

        // Store results in MongoDB
        for (const result of mlResults) {
            const finding = result.prediction || 'Optimal';
            const savings = result.recommendation?.monthly_savings || result.savings || 0;
            const originalInstance = instances.find(i => i.instance_id === result.instance_id);

            // Extract instance family from instance type (e.g., 't3' from 't3.medium')
            const instanceFamily = result.instance_type ? result.instance_type.split('.')[0] : null;

            // Determine architecture (most AWS instances are x86_64, some are arm64)
            const architecture = result.instance_type?.includes('graviton') || result.instance_type?.startsWith('a1') || result.instance_type?.startsWith('t4g') || result.instance_type?.startsWith('m6g') ? 'arm64' : 'x86_64';

            // Get recommended instance specs
            const recommendedSpecs = result.recommendation?.suggested_instance ?
                getEc2Specs(result.recommendation.suggested_instance) : null;

            // CRITICAL DEBUG: Log what specs we're about to save
            logger.info(`[SPECS SAVE] ${result.instance_id}: originalInstance vCPU=${originalInstance?.vcpu_count}, RAM=${originalInstance?.ram_gb} | ML vCPU=${result.metrics?.vcpu_count}, RAM=${result.metrics?.ram_gb}`);
            logger.info(`[SPECS SAVE] ${result.instance_id}: SAVING vCPU=${originalInstance?.vcpu_count || null}, RAM=${originalInstance?.ram_gb || null}`);

            await Resource.findOneAndUpdate(
                { resourceId: result.instance_id },
                {
                    $set: {
                        userId,
                        resourceId: result.instance_id,
                        name: originalInstance?.name || result.instance_id,
                        provider: 'AWS',
                        service: 'EC2',
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
                        estimatedMonthlyCost: result.currentCostPerMonth || result.current_cost_per_month || 0,
                        confidence: result.confidence || 0,
                        currentCost: result.currentCostPerMonth || result.current_cost_per_month || 0,
                        optimizedCost: result.optimizedCostPerMonth || (result.recommendation?.suggested_instance ?
                            (result.currentCostPerMonth - savings) : result.currentCostPerMonth) || 0,
                        recommendedType: result.recommendation?.suggested_instance || result.recommendedType || result.instance_type,

                        // NEW: Pricing transparency fields
                        price_source: 'live', // AWS pricing is fetched live
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

                        created: originalInstance?.launch_time,
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

        logger.info(`AWS EC2 sync complete for user ${userId}: ${mlResults.length} instances analyzed`);

        // Also fetch S3 buckets (no ML analysis needed)
        // S3 buckets are global, so we only need to fetch once using any region
        try {
            const s3Region = regionNames[0] || 'us-east-1'; // Use first available region or default
            const s3Client = new S3Client({
                region: s3Region,
                credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey }
            });
            const s3Data = await s3Client.send(new ListBucketsCommand({}));

            for (const bucket of s3Data.Buckets || []) {
                await Resource.findOneAndUpdate(
                    { resourceId: bucket.Name },
                    {
                        userId,
                        resourceId: bucket.Name,
                        name: bucket.Name,
                        provider: 'AWS',
                        service: 'S3',
                        region: 'global', // S3 buckets are global resources
                        resourceType: 'Bucket',
                        optimizationStatus: 'Optimal',
                        created: bucket.CreationDate,
                        lastFetched: Date.now()
                    },
                    { upsert: true }
                );
            }
            logger.info(`AWS S3 sync complete: ${s3Data.Buckets?.length || 0} buckets`);
        } catch (e) {
            logger.error("S3 Fetch Error", e);
        }

        return {
            success: true,
            instancesAnalyzed: mlResults.length,
            results: mlResults
        };

    } catch (error) {
        logger.error("AWS EC2 Fetch Error", error);
        throw error;
    }
};

/**
 * Fetch available AWS regions for the given credentials
 * Returns list of regions the user has access to
 */
const fetchAvailableRegions = async (creds) => {
    if (!creds.accessKeyId || !creds.secretAccessKey) {
        throw new Error("Missing AWS Credentials");
    }

    try {
        // Use EC2 client to describe regions
        const { DescribeRegionsCommand } = require("@aws-sdk/client-ec2");

        const ec2Client = new EC2Client({
            region: "us-east-1", // Use a default region to query available regions
            credentials: {
                accessKeyId: creds.accessKeyId,
                secretAccessKey: creds.secretAccessKey
            }
        });

        const command = new DescribeRegionsCommand({
            AllRegions: false, // Only return regions that are enabled for the account
            Filters: [
                {
                    Name: "opt-in-status",
                    Values: ["opt-in-not-required", "opted-in"]
                }
            ]
        });

        const response = await ec2Client.send(command);

        // Map regions to a more user-friendly format
        const regions = (response.Regions || []).map(region => ({
            regionName: region.RegionName,
            endpoint: region.Endpoint,
            optInStatus: region.OptInStatus
        }));

        logger.info(`Found ${regions.length} available AWS regions for user`);

        return {
            success: true,
            regions: regions,
            count: regions.length
        };
    } catch (error) {
        logger.error("Failed to fetch AWS regions:", error.message);
        throw new Error(`Failed to fetch available regions: ${error.message}`);
    }
};

/**
 * Fetch AWS EC2 resources and return data directly (no MongoDB persistence)
 * This method is used by the controller to fetch resources for localStorage storage
 * It reuses all the data fetching, normalization, enrichment, and ML prediction logic
 * from fetchResources() but skips MongoDB operations
 */
/**
 * Fetch AWS resources synchronously (for localStorage/frontend)
 * Returns raw cloud data with AWS Compute Optimizer recommendations
 * DOES NOT use ML service or save to MongoDB
 * This is the CORRECT implementation - returns only cloud provider data
 */
const fetchResourcesSync = async (userId, creds) => {
    const instances = [];

    try {
        // Fetch all available regions for this account
        logger.info(`[Sync] Fetching available AWS regions for user ${userId}`);
        const regionsResponse = await fetchAvailableRegions(creds);
        const availableRegions = regionsResponse.regions || [];
        const regionNames = availableRegions.map(r => r.regionName);
        logger.info(`[Sync] Found ${regionNames.length} enabled regions: ${regionNames.join(', ')}`);

        // Loop through each region and fetch instances
        for (const regionName of regionNames) {
            logger.info(`\n${'='.repeat(80)}`);
            logger.info(`🌍 [Sync] FETCHING RESOURCES FROM REGION: ${regionName}`);
            logger.info(`${'='.repeat(80)}\n`);

            try {
                const ec2Client = new EC2Client({
                    region: regionName,
                    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey }
                });

                const cloudWatchClient = new CloudWatchClient({
                    region: regionName,
                    credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey }
                });

                const ec2Data = await ec2Client.send(new DescribeInstancesCommand({}));

                // Skip region if no instances
                if (!ec2Data.Reservations || ec2Data.Reservations.length === 0) {
                    logger.info(`✅ [Sync] Region ${regionName}: No instances found, skipping`);
                    continue;
                }

                // Collect ALL instances from this region
                for (const reservation of ec2Data.Reservations || []) {
                    for (const instance of reservation.Instances || []) {
                        const instanceState = instance.State.Name;

                        // Fetch real specs from AWS API
                        const specs = await getEc2SpecsFromAWS(ec2Client, instance.InstanceType);
                        const instanceName = instance.Tags?.find(t => t.Key === 'Name')?.Value || instance.InstanceId;

                        // Calculate estimated monthly cost based on instance type
                        const estimatedHourlyCost = getEstimatedHourlyCost(instance.InstanceType, regionName);
                        const estimatedMonthlyCost = estimatedHourlyCost * 730; // 730 hours per month average

                        // Detect OS using authoritative method
                        const osInfo = await detectAWSOS(ec2Client, instance);
                        logger.info(`[Sync] Instance ${instanceName}: OS=${osInfo.os_type}, source=${osInfo.os_source}, confidence=${osInfo.os_confidence}`);

                        // Fetch CloudWatch metrics only for running instances
                        let metrics;
                        if (instanceState === 'running') {
                            logger.info(`[Sync] Fetching metrics for AWS instance ${instanceName} (${instanceState})`);
                            metrics = await fetchCloudWatchMetrics(cloudWatchClient, instance.InstanceId, regionName, instanceState);
                        } else {
                            logger.info(`[Sync] Skipping metrics for AWS instance ${instanceName} (${instanceState})`);
                            metrics = {
                                cpu_avg: null,
                                cpu_p95: null,
                                memory_avg: null,
                                memory_p95: null,
                                cpu_credit_balance: null,
                                network_in_bytes: 0,
                                network_out_bytes: 0,
                                disk_read_iops: 0,
                                disk_write_iops: 0,
                                metrics_status: 'missing',
                                memory_metrics_source: 'unavailable',
                                missing_metrics: [],
                                running_hours_last_14d: 0
                            };
                        }

                        const instanceData = {
                            instance_id: instance.InstanceId,
                            instance_type: instance.InstanceType,
                            region: regionName,
                            cloud: 'aws',
                            state: instanceState,
                            os: osInfo.os_type,
                            os_source: osInfo.os_source,
                            os_confidence: osInfo.os_confidence,
                            vcpu_count: specs.vCpu,
                            ram_gb: specs.memoryGb,
                            architecture: specs.architecture,
                            burstable: specs.burstable,
                            gpu: specs.gpu,
                            cpu_avg: metrics.cpu_avg,
                            cpu_p95: metrics.cpu_p95,
                            memory_avg: metrics.memory_avg,
                            memory_p95: metrics.memory_p95,
                            cpu_credit_balance: metrics.cpu_credit_balance,
                            disk_read_iops: metrics.disk_read_iops,
                            disk_write_iops: metrics.disk_write_iops,
                            network_in_bytes: metrics.network_in_bytes,
                            network_out_bytes: metrics.network_out_bytes,
                            metrics_status: metrics.metrics_status,
                            memory_metrics_source: metrics.memory_metrics_source,
                            missing_metrics: metrics.missing_metrics,
                            running_hours_last_14d: metrics.running_hours_last_14d,
                            cost_per_month: estimatedMonthlyCost, // Use estimated cost from pricing map
                            source: 'cloud',
                            name: instanceName,
                            launch_time: instance.LaunchTime
                        };

                        instances.push(instanceData);
                    }
                }

                logger.info(`✅ [Sync] Region ${regionName}: Collected ${ec2Data.Reservations?.length || 0} reservations`);

            } catch (regionError) {
                logger.error(`❌ [Sync] Error fetching from region ${regionName}:`, regionError.message);
                logger.info(`[Sync] Continuing with remaining regions...`);
            }
        }

        logger.info(`\n${'='.repeat(80)}`);
        logger.info(`✅ [Sync] AWS MULTI-REGION FETCH SUMMARY`);
        logger.info(`${'='.repeat(80)}`);
        logger.info(`Total Instances Collected: ${instances.length}`);
        logger.info(`Regions Scanned: ${regionNames.length}`);
        logger.info(`User ID: ${userId}`);
        logger.info(`${'='.repeat(80)}\n`);

        // Fetch Compute Optimizer recommendations for all instances
        logger.info(`\n${'='.repeat(80)}`);
        logger.info(`🔍 [Sync] FETCHING COMPUTE OPTIMIZER RECOMMENDATIONS`);
        logger.info(`${'='.repeat(80)}\n`);

        const computeOptimizerMap = new Map();

        try {
            // Group instances by region for efficient API calls
            const instancesByRegion = {};
            instances.forEach(inst => {
                if (!instancesByRegion[inst.region]) {
                    instancesByRegion[inst.region] = [];
                }
                instancesByRegion[inst.region].push(inst.instance_id);
            });

            // Fetch Compute Optimizer data for each region
            for (const [region, instanceIds] of Object.entries(instancesByRegion)) {
                try {
                    logger.info(`[Sync] Fetching Compute Optimizer data for ${instanceIds.length} instances in ${region}`);

                    const recommendations = await fetchComputeOptimizerRecommendations(
                        creds,
                        region,
                        null // Fetch all recommendations for the region
                    );

                    logger.info(`[Sync] Received ${recommendations.length} Compute Optimizer recommendations for ${region}`);

                    // Map recommendations by instance_id
                    recommendations.forEach(rec => {
                        computeOptimizerMap.set(rec.instance_id, rec);
                    });

                } catch (coError) {
                    logger.warn(`[Sync] Failed to fetch Compute Optimizer data for region ${region}:`, coError.message);
                    logger.info(`[Sync] Continuing without Compute Optimizer data for ${region}...`);
                }
            }

            logger.info(`[Sync] Compute Optimizer data collected for ${computeOptimizerMap.size} instances`);

        } catch (coError) {
            logger.error(`[Sync] Error fetching Compute Optimizer recommendations:`, coError.message);
            logger.info(`[Sync] Continuing without Compute Optimizer data...`);
        }

        logger.info(`${'='.repeat(80)}\n`);

        // Build final results array with all required fields for frontend
        // For Cloud Connect method: Use ONLY AWS Compute Optimizer (NO ML service)
        const results = instances.map(originalInstance => {
            // Get Compute Optimizer recommendation for this instance
            const computeOptimizerRec = computeOptimizerMap.get(originalInstance.instance_id);

            // Extract instance family
            const instanceFamily = originalInstance.instance_type ? originalInstance.instance_type.split('.')[0] : null;

            // Determine architecture
            const architecture = originalInstance.instance_type?.includes('graviton') ||
                originalInstance.instance_type?.startsWith('a1') ||
                originalInstance.instance_type?.startsWith('t4g') ||
                originalInstance.instance_type?.startsWith('m6g') ? 'arm64' : 'x86_64';

            // Get recommended instance specs from Compute Optimizer
            const bestRecommendation = computeOptimizerRec?.recommendation_options?.[0];
            const recommendedSpecs = bestRecommendation?.instance_type ?
                getEc2Specs(bestRecommendation.instance_type) : null;

            // Determine optimization status from Compute Optimizer finding
            // If no Compute Optimizer data, set to null (will show "Insufficient Data")
            const optimizationStatus = computeOptimizerRec?.finding || null;
            const estimatedSavings = bestRecommendation?.estimated_monthly_savings || 0;

            // BUGFIX: Map AWS Compute Optimizer savings to potential_monthly_savings field
            // This ensures the frontend displays actual savings from AWS recommendations
            let potential_monthly_savings = 0;
            if (computeOptimizerRec?.recommendation_options &&
                computeOptimizerRec.recommendation_options.length > 0) {
                const bestOption = computeOptimizerRec.recommendation_options[0];
                // Use the savings value directly - can be positive (save money) or negative (cost increase)
                potential_monthly_savings = bestOption.estimated_monthly_savings || 0;

                // Log for debugging
                if (potential_monthly_savings < 0) {
                    console.log(`[AWS Savings] ${originalInstance.instance_id}: COST INCREASE of $${Math.abs(potential_monthly_savings).toFixed(2)}/month (Under-Provisioned)`);
                } else if (potential_monthly_savings > 0) {
                    console.log(`[AWS Savings] ${originalInstance.instance_id}: SAVINGS of $${potential_monthly_savings.toFixed(2)}/month (Over-Provisioned)`);
                } else {
                    console.log(`[AWS Savings] ${originalInstance.instance_id}: $0.00/month (Optimized or No Data)`);
                }
            } else {
                potential_monthly_savings = 0;
            }

            return {
                // Core identification
                instance_id: originalInstance.instance_id,
                resourceId: originalInstance.instance_id,
                name: originalInstance.name || originalInstance.instance_id,
                provider: 'AWS',
                service: 'EC2',
                cloud: 'aws',

                // Location and type
                region: originalInstance.region,
                resourceType: originalInstance.instance_type,
                instance_type: originalInstance.instance_type,
                state: originalInstance.state || 'unknown',
                status: originalInstance.state || 'unknown',

                // Hardware specs
                vCpu: originalInstance.vcpu_count || null,
                vcpu_count: originalInstance.vcpu_count || null,
                memoryGb: originalInstance.ram_gb || null,
                ram_gb: originalInstance.ram_gb || null,
                architecture: architecture,
                burstable: originalInstance.burstable || false,
                gpu: originalInstance.gpu || false,

                // Metrics
                avgCpuUtilization: originalInstance.cpu_avg ?? null,
                cpu_avg: originalInstance.cpu_avg ?? null,
                maxCpuUtilization: originalInstance.cpu_p95 ?? null,
                cpu_p95: originalInstance.cpu_p95 ?? null,
                avgMemoryUtilization: originalInstance.memory_avg ?? null,
                memory_avg: originalInstance.memory_avg ?? null,
                maxMemoryUtilization: originalInstance.memory_p95 ?? null,
                memory_p95: originalInstance.memory_p95 ?? null,
                networkIn: originalInstance.network_in_bytes || 0,
                network_in_bytes: originalInstance.network_in_bytes || 0,
                networkOut: originalInstance.network_out_bytes || 0,
                network_out_bytes: originalInstance.network_out_bytes || 0,
                diskReadBytes: originalInstance.disk_read_iops || 0,
                disk_read_iops: originalInstance.disk_read_iops || 0,
                diskWriteBytes: originalInstance.disk_write_iops || 0,
                disk_write_iops: originalInstance.disk_write_iops || 0,
                metrics_status: originalInstance.metrics_status || 'missing',
                memory_metrics_source: originalInstance.memory_metrics_source || 'unavailable',

                // Optimization - Use ONLY Compute Optimizer (NO ML)
                optimizationStatus: optimizationStatus,
                recommendation: null, // No ML recommendations
                estimatedSavings: estimatedSavings,
                potential_monthly_savings: potential_monthly_savings, // CRITICAL: Frontend expects this field
                estimatedMonthlyCost: originalInstance.cost_per_month || 0,
                confidence: null, // No ML confidence
                prediction_confidence: null, // No ML confidence
                currentCost: originalInstance.cost_per_month || 0,
                optimizedCost: bestRecommendation ?
                    (originalInstance.cost_per_month - estimatedSavings) : originalInstance.cost_per_month,
                recommendedType: bestRecommendation?.instance_type || null,
                recommendedVcpu: recommendedSpecs?.vCpu || null,
                recommendedMemory: recommendedSpecs?.memoryGb || null,

                // OS detection
                os: originalInstance.os || 'unknown',
                os_type: originalInstance.os || 'unknown',
                os_source: originalInstance.os_source || 'unresolved',
                os_confidence: originalInstance.os_confidence || 'low',

                // Pricing
                price_source: 'live',
                price_last_updated: new Date(),

                // Architecture & compatibility
                instance_family: instanceFamily,
                available_in_region: true,

                // Recommendation reason - Use Compute Optimizer finding
                reason: computeOptimizerRec ?
                    (optimizationStatus === 'Overprovisioned' ? 'Instance is over-provisioned based on AWS Compute Optimizer analysis. Downsizing will reduce costs.' :
                        optimizationStatus === 'Underprovisioned' ? 'Instance is under-provisioned and may experience performance issues. Upgrading is recommended.' :
                            optimizationStatus === 'Optimized' ? 'Instance is optimally sized according to AWS Compute Optimizer.' :
                                'Insufficient data for recommendation') :
                    'Insufficient data for recommendation',

                // AWS Compute Optimizer fields
                compute_optimizer_finding: computeOptimizerRec?.finding || null,
                compute_optimizer_finding_reasons: computeOptimizerRec?.finding_reasons || [],
                compute_optimizer_recommendation_options: computeOptimizerRec?.recommendation_options || [],
                compute_optimizer_last_refresh: computeOptimizerRec ? new Date() : null,
                compute_optimizer_lookback_period: computeOptimizerRec?.look_back_period_in_days || 14,
                compute_optimizer_current_cpu: computeOptimizerRec?.current_cpu_utilization || null,
                compute_optimizer_current_memory: computeOptimizerRec?.current_memory_utilization || null,

                // Timestamps
                created: originalInstance.launch_time,
                launch_time: originalInstance.launch_time,
                lastFetched: Date.now(),

                // Full metrics object (from original instance, not ML)
                metrics: {
                    cpu_avg: originalInstance.cpu_avg,
                    cpu_p95: originalInstance.cpu_p95,
                    memory_avg: originalInstance.memory_avg,
                    memory_p95: originalInstance.memory_p95,
                    network_in_bytes: originalInstance.network_in_bytes,
                    network_out_bytes: originalInstance.network_out_bytes,
                    disk_read_iops: originalInstance.disk_read_iops,
                    disk_write_iops: originalInstance.disk_write_iops,
                    vcpu_count: originalInstance.vcpu_count,
                    ram_gb: originalInstance.ram_gb
                }
            };
        });

        logger.info(`[Sync] AWS EC2 sync complete for user ${userId}: ${results.length} instances processed`);
        logger.info(`[Sync] ML service was NOT used - using ONLY AWS Compute Optimizer recommendations`);

        // Return array of resource objects (NO MongoDB operations)
        return results;

    } catch (error) {
        logger.error("[Sync] AWS EC2 Fetch Error", error);
        throw error;
    }
};

module.exports = { testConnection, fetchResources, fetchResourcesSync, fetchAvailableRegions, fetchRealtimeMetrics, fetchComputeOptimizerRecommendations, convertTimeRangeToSeconds, clampValue, calculateAverage };
