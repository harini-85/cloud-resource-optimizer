const { ComputeOptimizerClient, GetEnrollmentStatusCommand, GetEC2InstanceRecommendationsCommand } = require("@aws-sdk/client-compute-optimizer");
const logger = require('./logger');

/**
 * Diagnostic tool to check AWS Compute Optimizer status
 * Run this to verify your AWS account setup
 */
const diagnoseComputeOptimizer = async (credentials) => {
    try {
        console.log('\n========================================');
        console.log('AWS COMPUTE OPTIMIZER DIAGNOSTICS');
        console.log('========================================\n');

        const client = new ComputeOptimizerClient({
            region: 'us-east-1',
            credentials: {
                accessKeyId: credentials.accessKeyId,
                secretAccessKey: credentials.secretAccessKey
            }
        });

        // Step 1: Check enrollment status
        console.log('1. Checking Compute Optimizer enrollment status...');
        try {
            const enrollmentCommand = new GetEnrollmentStatusCommand({});
            const enrollmentResponse = await client.send(enrollmentCommand);

            console.log('   ✅ Enrollment Status:', enrollmentResponse.status);
            console.log('   - Status Reason:', enrollmentResponse.statusReason || 'N/A');

            if (enrollmentResponse.status !== 'Active') {
                console.log('\n   ⚠️  WARNING: Compute Optimizer is NOT active!');
                console.log('   - Go to AWS Console → Compute Optimizer');
                console.log('   - Click "Opt in" to enable the service');
                console.log('   - Wait 12-24 hours for data collection\n');
                return {
                    success: false,
                    error: 'Compute Optimizer not enabled',
                    enrollmentStatus: enrollmentResponse.status
                };
            }
        } catch (enrollmentError) {
            console.log('   ❌ Failed to check enrollment:', enrollmentError.message);
            console.log('   - Error Code:', enrollmentError.name);

            if (enrollmentError.name === 'AccessDeniedException') {
                console.log('\n   ⚠️  PERMISSION ERROR!');
                console.log('   - Missing IAM permission: compute-optimizer:GetEnrollmentStatus');
                console.log('   - Add this policy to your IAM user\n');
            }

            return {
                success: false,
                error: 'Permission denied or service unavailable',
                errorCode: enrollmentError.name
            };
        }

        // Step 2: Try to fetch recommendations
        console.log('\n2. Fetching EC2 instance recommendations...');
        try {
            const recommendationsCommand = new GetEC2InstanceRecommendationsCommand({
                maxResults: 10
            });

            const recommendationsResponse = await client.send(recommendationsCommand);
            const recommendations = recommendationsResponse.instanceRecommendations || [];

            console.log('   ✅ Successfully fetched recommendations');
            console.log('   - Total recommendations found:', recommendations.length);

            if (recommendations.length === 0) {
                console.log('\n   ⚠️  No recommendations available yet');
                console.log('   - Instances need 14+ days of metrics');
                console.log('   - Check back in a few days\n');
            } else {
                console.log('\n   📊 Sample recommendations:');
                recommendations.slice(0, 3).forEach((rec, idx) => {
                    const instanceId = rec.instanceArn?.split('/').pop() || 'unknown';
                    console.log(`   ${idx + 1}. Instance: ${instanceId}`);
                    console.log(`      - Current Type: ${rec.currentInstanceType}`);
                    console.log(`      - Finding: ${rec.finding}`);
                    console.log(`      - Options: ${rec.recommendationOptions?.length || 0}`);
                });
            }

            return {
                success: true,
                recommendationCount: recommendations.length,
                recommendations: recommendations
            };

        } catch (recommendationsError) {
            console.log('   ❌ Failed to fetch recommendations:', recommendationsError.message);
            console.log('   - Error Code:', recommendationsError.name);

            if (recommendationsError.name === 'OptInRequiredException') {
                console.log('\n   ⚠️  COMPUTE OPTIMIZER NOT ENABLED!');
                console.log('   - Go to: https://console.aws.amazon.com/compute-optimizer/');
                console.log('   - Click "Get started" or "Opt in"');
                console.log('   - Enable for your account\n');
            } else if (recommendationsError.name === 'AccessDeniedException') {
                console.log('\n   ⚠️  PERMISSION ERROR!');
                console.log('   - Missing IAM permission: compute-optimizer:GetEC2InstanceRecommendations');
                console.log('   - Attach ComputeOptimizerReadOnlyAccess policy\n');
            }

            return {
                success: false,
                error: recommendationsError.message,
                errorCode: recommendationsError.name
            };
        }

    } catch (error) {
        console.log('\n❌ DIAGNOSTIC FAILED:', error.message);
        return {
            success: false,
            error: error.message
        };
    } finally {
        console.log('\n========================================');
        console.log('DIAGNOSTICS COMPLETE');
        console.log('========================================\n');
    }
};

module.exports = { diagnoseComputeOptimizer };
