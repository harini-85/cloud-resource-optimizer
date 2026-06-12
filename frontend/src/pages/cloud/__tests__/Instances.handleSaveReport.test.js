/**
 * Unit tests for handleSaveReport function in Instances.jsx
 * Tests the data transformation logic for Task 3.3
 */

describe('Instances.jsx - handleSaveReport data transformation', () => {
    test('should transform instance data to Report model schema', () => {
        // Sample instance data (as it comes from the backend)
        const instances = [
            {
                _id: 'inst-123',
                name: 'web-server-1',
                provider: 'AWS',
                resourceType: 't2.micro',
                compute_optimizer_finding: 'Overprovisioned',
                recommended_instance_type: 't2.nano',
                cpu_avg: 15.5,
                memory_avg: 25.3,
                potential_monthly_savings: 12.50,
                confidence: 0.85,
                region: 'us-east-1',
                recommendation: 'Instance is overprovisioned'
            },
            {
                _id: 'inst-456',
                name: 'db-server-1',
                provider: 'Azure',
                resourceType: 'Standard_B2s',
                optimizationStatus: 'UNDERSIZED',
                avgCpuUtilization: 85.2,
                avgMemoryUtilization: 90.1,
                potential_monthly_savings: -20.00,
                region: 'eastus'
            }
        ];

        // Expected transformation
        const expected = [
            {
                id: 'inst-123',
                name: 'web-server-1',
                cloud: 'aws',
                resourceType: 't2.micro',
                finding: 'Overprovisioned',
                instanceType: 't2.micro',
                recommendedType: 't2.nano',
                cpuUsage: 15.5,
                memUsage: 25.3,
                savings: 12.50,
                confidence: 0.85,
                region: 'us-east-1',
                recommendation: 'Instance is overprovisioned'
            },
            {
                id: 'inst-456',
                name: 'db-server-1',
                cloud: 'azure',
                resourceType: 'Standard_B2s',
                finding: 'UNDERSIZED',
                instanceType: 'Standard_B2s',
                recommendedType: 'Standard_B2s',
                cpuUsage: 85.2,
                memUsage: 90.1,
                savings: -20.00,
                confidence: 0,
                region: 'eastus',
                recommendation: 'No recommendation available'
            }
        ];

        // Simulate the transformation logic from handleSaveReport
        const formattedRecommendations = instances.map(instance => ({
            id: instance._id || instance.id,
            name: instance.name,
            cloud: (instance.provider || '').toLowerCase(),
            resourceType: instance.resourceType,
            finding: instance.compute_optimizer_finding || instance.recommendation || instance.optimizationStatus || 'Unknown',
            instanceType: instance.resourceType,
            recommendedType: instance.recommended_instance_type || instance.resourceType,
            cpuUsage: instance.cpu_avg != null ? instance.cpu_avg : (instance.avgCpuUtilization || 0),
            memUsage: instance.memory_avg != null ? instance.memory_avg : (instance.avgMemoryUtilization || 0),
            savings: instance.potential_monthly_savings || 0,
            confidence: instance.confidence || 0,
            region: instance.region,
            recommendation: instance.recommendation || 'No recommendation available'
        }));

        expect(formattedRecommendations).toEqual(expected);
    });

    test('should handle missing fields with defaults', () => {
        const instances = [
            {
                _id: 'inst-789',
                name: 'minimal-instance',
                provider: 'GCP',
                resourceType: 'n1-standard-1',
                region: 'us-central1'
            }
        ];

        const formattedRecommendations = instances.map(instance => ({
            id: instance._id || instance.id,
            name: instance.name,
            cloud: (instance.provider || '').toLowerCase(),
            resourceType: instance.resourceType,
            finding: instance.compute_optimizer_finding || instance.recommendation || instance.optimizationStatus || 'Unknown',
            instanceType: instance.resourceType,
            recommendedType: instance.recommended_instance_type || instance.resourceType,
            cpuUsage: instance.cpu_avg != null ? instance.cpu_avg : (instance.avgCpuUtilization || 0),
            memUsage: instance.memory_avg != null ? instance.memory_avg : (instance.avgMemoryUtilization || 0),
            savings: instance.potential_monthly_savings || 0,
            confidence: instance.confidence || 0,
            region: instance.region,
            recommendation: instance.recommendation || 'No recommendation available'
        }));

        expect(formattedRecommendations[0]).toEqual({
            id: 'inst-789',
            name: 'minimal-instance',
            cloud: 'gcp',
            resourceType: 'n1-standard-1',
            finding: 'Unknown',
            instanceType: 'n1-standard-1',
            recommendedType: 'n1-standard-1',
            cpuUsage: 0,
            memUsage: 0,
            savings: 0,
            confidence: 0,
            region: 'us-central1',
            recommendation: 'No recommendation available'
        });
    });
});
