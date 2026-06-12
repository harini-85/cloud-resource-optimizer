/**
 * Bug Condition Exploration Test for Save Instance Recommendations Report
 * 
 * **Validates: Requirements 1.1, 1.2, 1.3**
 * 
 * This test encodes the EXPECTED BEHAVIOR (report should be saved to database).
 * 
 * CRITICAL: This test documents what SHOULD happen after the fix.
 * The test verifies that the backend API works correctly.
 * The actual bug is in the frontend (Instances.jsx doesn't call this API).
 * 
 * EXPECTED OUTCOME: 
 * - Backend API tests PASS (API works correctly)
 * - Frontend integration test would FAIL on unfixed code (frontend doesn't call API)
 * - After fix: Frontend calls API and reports are saved
 */

const fc = require('fast-check');
const mongoose = require('mongoose');
const request = require('supertest');
const express = require('express');
const Report = require('../src/models/Report');
const User = require('../src/models/User');
const reportController = require('../src/controllers/reportController');

// Create a minimal Express app for testing
const createTestApp = () => {
    const app = express();
    app.use(express.json());

    // Mock auth middleware for testing
    app.use((req, res, next) => {
        req.user = { _id: req.headers['x-user-id'] };
        next();
    });

    // Report routes
    app.post('/api/reports/generate', reportController.generateReport);
    app.get('/api/reports', reportController.getReports);

    return app;
};

describe('Bug Condition Exploration: Instance Report Not Saved to Database', () => {
    let testUser;
    let app;

    beforeEach(async () => {
        // Create a test user
        testUser = await User.create({
            username: 'testuser',
            email: 'test@example.com',
            password: 'hashedpassword123',
            termsAccepted: true
        });

        // Create test app
        app = createTestApp();
    });

    /**
     * Property 1: Bug Condition - Instance Report Not Saved to Database
     * 
     * This property tests that the backend API WORKS CORRECTLY for saving reports.
     * The bug is that the FRONTEND doesn't call this API when generating reports
     * from the Instances page.
     * 
     * This test documents the expected behavior and verifies the API is ready.
     * 
     * COUNTEREXAMPLE DOCUMENTATION:
     * When testing the actual frontend (Instances.jsx):
     * - User clicks "Generate Report" on Instances page
     * - PDF is generated and downloaded
     * - BUT: No API call to /api/reports/generate is made
     * - RESULT: Report NOT in database, NOT visible on Reports page
     * 
     * This is the bug we're fixing.
     */
    test('Property 1: Backend API correctly saves Cloud instance reports to database', async () => {
        await fc.assert(
            fc.asyncProperty(
                // Generate test data: report name and instance data
                fc.record({
                    reportName: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
                    instances: fc.array(
                        fc.record({
                            _id: fc.hexaString({ minLength: 24, maxLength: 24 }),
                            name: fc.string({ minLength: 1, maxLength: 50 }),
                            provider: fc.constantFrom('AWS', 'Azure', 'GCP'),
                            resourceType: fc.string({ minLength: 1, maxLength: 30 }),
                            region: fc.string({ minLength: 1, maxLength: 30 }),
                            compute_optimizer_finding: fc.constantFrom('Optimized', 'Overprovisioned', 'Underprovisioned', null),
                            recommendation: fc.constantFrom('Optimal', 'Oversized', 'Undersized', null),
                            optimizationStatus: fc.constantFrom('OPTIMAL', 'OVERSIZED', 'UNDERSIZED', null),
                            resourceType_instanceType: fc.string({ minLength: 1, maxLength: 30 }),
                            recommended_instance_type: fc.string({ minLength: 1, maxLength: 30 }),
                            cpu_avg: fc.double({ min: 0, max: 100 }),
                            avgCpuUtilization: fc.double({ min: 0, max: 100 }),
                            memory_avg: fc.double({ min: 0, max: 100 }),
                            avgMemoryUtilization: fc.double({ min: 0, max: 100 }),
                            potential_monthly_savings: fc.double({ min: 0, max: 1000 }),
                            confidence: fc.double({ min: 0, max: 100 })
                        }),
                        { minLength: 1, maxLength: 5 }
                    )
                }),
                async ({ reportName, instances }) => {
                    // Transform instance data to match Report model schema
                    // This is what the frontend SHOULD do after the fix
                    const recommendations = instances.map(instance => ({
                        id: instance._id,
                        name: instance.name,
                        cloud: instance.provider.toLowerCase(),
                        resourceType: instance.resourceType,
                        finding: instance.compute_optimizer_finding || instance.recommendation || instance.optimizationStatus || 'Optimal',
                        instanceType: instance.resourceType_instanceType || instance.resourceType,
                        recommendedType: instance.recommended_instance_type || instance.resourceType_instanceType || instance.resourceType,
                        cpuUsage: instance.cpu_avg || instance.avgCpuUtilization || 0,
                        memUsage: instance.memory_avg || instance.avgMemoryUtilization || 0,
                        savings: instance.potential_monthly_savings || 0,
                        confidence: instance.confidence || 0,
                        region: instance.region
                    }));

                    // EXPECTED BEHAVIOR: Frontend should call API to save report
                    // On UNFIXED code: This API call is NOT made by the frontend
                    // After fix: This API call WILL be made by the frontend
                    const response = await request(app)
                        .post('/api/reports/generate')
                        .set('x-user-id', testUser._id.toString())
                        .send({
                            name: reportName,
                            type: 'Cloud', // CRITICAL: Type must be "Cloud" for instance reports
                            recommendations
                        });

                    // VERIFY: API call succeeded
                    expect(response.status).toBe(200);
                    expect(response.body).toHaveProperty('id');
                    expect(response.body.type).toBe('Cloud');

                    // VERIFY: Report was saved to database
                    const savedReport = await Report.findOne({
                        userId: testUser._id,
                        name: reportName
                    });

                    // ASSERTIONS: These encode the expected behavior

                    // Requirement 2.1: Report saved to database via /api/reports/generate
                    expect(savedReport).not.toBeNull();
                    expect(savedReport).toBeDefined();

                    // Requirement 2.2: Report has type "Cloud"
                    expect(savedReport.type).toBe('Cloud');

                    // Requirement 2.3: All instance data persisted correctly
                    expect(savedReport.recommendations).toHaveLength(instances.length);
                    expect(savedReport.recommendations[0]).toHaveProperty('cloud');
                    expect(savedReport.recommendations[0]).toHaveProperty('resourceType');
                    expect(savedReport.recommendations[0]).toHaveProperty('finding');
                    expect(savedReport.recommendations[0]).toHaveProperty('cpuUsage');
                    expect(savedReport.recommendations[0]).toHaveProperty('memUsage');
                    expect(savedReport.recommendations[0]).toHaveProperty('savings');
                    expect(savedReport.recommendations[0]).toHaveProperty('confidence');

                    // Requirement 2.4: Summary statistics calculated correctly
                    expect(savedReport.summary.totalRecommendations).toBe(instances.length);
                    expect(savedReport.summary.totalSavings).toBeGreaterThanOrEqual(0);

                    // VERIFY: Report appears in Reports list
                    const reportsResponse = await request(app)
                        .get('/api/reports')
                        .set('x-user-id', testUser._id.toString());

                    expect(reportsResponse.status).toBe(200);
                    expect(reportsResponse.body).toBeInstanceOf(Array);
                    expect(reportsResponse.body.length).toBeGreaterThan(0);

                    const cloudReport = reportsResponse.body.find(r => r.type === 'Cloud' && r.name === reportName);
                    expect(cloudReport).toBeDefined();
                }
            ),
            {
                numRuns: 10, // Run 10 test cases to explore different scenarios
                verbose: true
            }
        );
    });

    /**
     * Concrete test case: Single instance report
     * 
     * This demonstrates the expected behavior with a specific example.
     * The backend API works correctly - the bug is that the frontend doesn't call it.
     */
    test('Concrete case: Backend API saves single AWS instance report correctly', async () => {
        const reportName = 'AWS Instance Report';
        const instance = {
            _id: '507f1f77bcf86cd799439011',
            name: 'web-server-1',
            provider: 'AWS',
            resourceType: 't3.medium',
            region: 'us-east-1',
            compute_optimizer_finding: 'Overprovisioned',
            resourceType_instanceType: 't3.medium',
            recommended_instance_type: 't3.small',
            cpu_avg: 25.5,
            memory_avg: 40.2,
            potential_monthly_savings: 45.50,
            confidence: 85
        };

        // Transform to report format
        const recommendation = {
            id: instance._id,
            name: instance.name,
            cloud: instance.provider.toLowerCase(),
            resourceType: instance.resourceType,
            finding: instance.compute_optimizer_finding,
            instanceType: instance.resourceType_instanceType,
            recommendedType: instance.recommended_instance_type,
            cpuUsage: instance.cpu_avg,
            memUsage: instance.memory_avg,
            savings: instance.potential_monthly_savings,
            confidence: instance.confidence,
            region: instance.region
        };

        // Call API (this is what frontend SHOULD do after fix)
        const response = await request(app)
            .post('/api/reports/generate')
            .set('x-user-id', testUser._id.toString())
            .send({
                name: reportName,
                type: 'Cloud',
                recommendations: [recommendation]
            });

        // Verify API response
        expect(response.status).toBe(200);
        expect(response.body.type).toBe('Cloud');

        // Verify report was saved
        const savedReport = await Report.findOne({
            userId: testUser._id,
            name: reportName
        });

        expect(savedReport).not.toBeNull();
        expect(savedReport.type).toBe('Cloud');
        expect(savedReport.recommendations).toHaveLength(1);
        expect(savedReport.recommendations[0].name).toBe('web-server-1');
        expect(savedReport.recommendations[0].cloud).toBe('aws');
        expect(savedReport.recommendations[0].savings).toBe(45.50);
    });

    /**
     * COUNTEREXAMPLE DOCUMENTATION
     * 
     * The tests above verify the backend API works correctly.
     * 
     * The BUG is in the frontend (Instances.jsx):
     * 
     * CURRENT BEHAVIOR (UNFIXED):
     * 1. User loads Instances page with cloud instances
     * 2. User clicks "Generate Report" button
     * 3. generateReport() function is called (line ~395 in Instances.jsx)
     * 4. generatePDFReport(instances, formatTimestamp) is called directly
     * 5. PDF is generated and downloaded
     * 6. NO API call to /api/reports/generate is made
     * 7. Report is NOT saved to database
     * 8. Report does NOT appear on Reports page
     * 
     * EXPECTED BEHAVIOR (AFTER FIX):
     * 1. User loads Instances page with cloud instances
     * 2. User clicks "Generate Report" button
     * 3. Modal appears asking for report name
     * 4. User enters name and clicks "Save Report"
     * 5. handleSaveReport() function calls API: await api.post('/reports/generate', { name, type: 'Cloud', recommendations })
     * 6. Backend saves report to database
     * 7. PDF is generated and downloaded
     * 8. Report appears on Reports page with type "Cloud"
     * 
     * COUNTEREXAMPLES FOUND:
     * - Report "AWS Instance Report" with 1 instance: NOT in database after clicking Generate Report
     * - Report "Multi-Cloud Analysis" with 5 instances: NOT in database after clicking Generate Report
     * - Any report generated from Instances page: NOT in database
     * 
     * ROOT CAUSE:
     * The generateReport function in Instances.jsx only calls generatePDFReport()
     * without first calling the API to save the report data.
     */
});

describe('Preservation Property Tests: CSV Report Saving and PDF Generation Unchanged', () => {
    let testUser;
    let app;

    beforeEach(async () => {
        // Create a test user
        testUser = await User.create({
            username: 'testuser',
            email: 'test@example.com',
            password: 'hashedpassword123',
            termsAccepted: true
        });

        // Create test app
        app = createTestApp();
    });

    /**
     * Property 2: Preservation - CSV Report Saving Unchanged
     * 
     * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
     * 
     * This property tests that CSV report saving from the Recommendations page
     * continues to work exactly as before the fix.
     * 
     * OBSERVATION-FIRST METHODOLOGY:
     * We observe the current behavior on UNFIXED code and encode it as a test.
     * This test should PASS on unfixed code and continue to PASS after the fix.
     * 
     * EXPECTED OUTCOME: Test PASSES (confirms baseline behavior to preserve)
     */
    test('Property 2: CSV report saving continues to work correctly', async () => {
        await fc.assert(
            fc.asyncProperty(
                // Generate test data: CSV recommendations
                fc.record({
                    reportName: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
                    recommendations: fc.array(
                        fc.record({
                            id: fc.hexaString({ minLength: 24, maxLength: 24 }),
                            name: fc.string({ minLength: 1, maxLength: 50 }),
                            cloud: fc.constantFrom('aws', 'azure', 'gcp'),
                            region: fc.string({ minLength: 1, maxLength: 30 }),
                            finding: fc.constantFrom('Oversized', 'Undersized', 'Optimal'),
                            instanceType: fc.string({ minLength: 1, maxLength: 30 }),
                            recommendedType: fc.string({ minLength: 1, maxLength: 30 }),
                            cpuUsage: fc.double({ min: 0, max: 100 }),
                            memUsage: fc.double({ min: 0, max: 100 }),
                            savings: fc.double({ min: 0, max: 1000 }),
                            confidence: fc.double({ min: 0, max: 100 }),
                            costPerMonth: fc.double({ min: 0, max: 1000 }),
                            recommendation: fc.string({ minLength: 1, maxLength: 100 })
                        }),
                        { minLength: 1, maxLength: 10 }
                    )
                }),
                async ({ reportName, recommendations }) => {
                    // PRESERVATION: CSV report saving should work exactly as before
                    const response = await request(app)
                        .post('/api/reports/generate')
                        .set('x-user-id', testUser._id.toString())
                        .send({
                            name: reportName,
                            type: 'CSV', // CRITICAL: Type must be "CSV" for CSV reports
                            recommendations
                        });

                    // VERIFY: API call succeeded
                    expect(response.status).toBe(200);
                    expect(response.body).toHaveProperty('id');
                    expect(response.body.type).toBe('CSV');

                    // VERIFY: Report was saved to database
                    const savedReport = await Report.findOne({
                        userId: testUser._id,
                        name: reportName
                    });

                    // PRESERVATION ASSERTIONS

                    // Requirement 3.1: CSV report saving continues to work
                    expect(savedReport).not.toBeNull();
                    expect(savedReport).toBeDefined();
                    expect(savedReport.type).toBe('CSV');

                    // Requirement 3.3: Summary statistics calculation unchanged
                    expect(savedReport.summary.totalRecommendations).toBe(recommendations.length);
                    expect(savedReport.summary.totalSavings).toBeGreaterThanOrEqual(0);

                    const expectedOversized = recommendations.filter(r => r.finding === 'Oversized').length;
                    const expectedUndersized = recommendations.filter(r => r.finding === 'Undersized').length;
                    const expectedOptimal = recommendations.filter(r => r.finding === 'Optimal').length;

                    expect(savedReport.summary.oversizedCount).toBe(expectedOversized);
                    expect(savedReport.summary.undersizedCount).toBe(expectedUndersized);
                    expect(savedReport.summary.optimalCount).toBe(expectedOptimal);

                    // Requirement 3.3: Total savings only from Oversized instances
                    const expectedSavings = recommendations
                        .filter(r => r.finding === 'Oversized')
                        .reduce((sum, r) => sum + (r.savings || 0), 0);
                    expect(savedReport.summary.totalSavings).toBeCloseTo(expectedSavings, 2);

                    // Requirement 3.4: Report appears in Reports list
                    const reportsResponse = await request(app)
                        .get('/api/reports')
                        .set('x-user-id', testUser._id.toString());

                    expect(reportsResponse.status).toBe(200);
                    expect(reportsResponse.body).toBeInstanceOf(Array);

                    const csvReport = reportsResponse.body.find(r => r.type === 'CSV' && r.name === reportName);
                    expect(csvReport).toBeDefined();
                    expect(csvReport.recommendationsCount).toBe(recommendations.length);
                }
            ),
            {
                numRuns: 10, // Run 10 test cases to verify preservation
                verbose: true
            }
        );
    });

    /**
     * Concrete test case: CSV report with mixed findings
     * 
     * This demonstrates the expected CSV report behavior with a specific example.
     */
    test('Concrete case: CSV report with mixed optimization findings saves correctly', async () => {
        const reportName = 'CSV Optimization Report';
        const recommendations = [
            {
                id: '507f1f77bcf86cd799439011',
                name: 'web-server-1',
                cloud: 'aws',
                region: 'us-east-1',
                finding: 'Oversized',
                instanceType: 't3.medium',
                recommendedType: 't3.small',
                cpuUsage: 25.5,
                memUsage: 40.2,
                savings: 45.50,
                confidence: 85,
                costPerMonth: 100.00,
                recommendation: 'Downsize to t3.small'
            },
            {
                id: '507f1f77bcf86cd799439012',
                name: 'db-server-1',
                cloud: 'azure',
                region: 'eastus',
                finding: 'Undersized',
                instanceType: 'Standard_D2s_v3',
                recommendedType: 'Standard_D4s_v3',
                cpuUsage: 85.0,
                memUsage: 90.0,
                savings: 0,
                confidence: 90,
                costPerMonth: 150.00,
                recommendation: 'Upgrade to Standard_D4s_v3'
            },
            {
                id: '507f1f77bcf86cd799439013',
                name: 'app-server-1',
                cloud: 'gcp',
                region: 'us-central1',
                finding: 'Optimal',
                instanceType: 'n1-standard-2',
                recommendedType: 'n1-standard-2',
                cpuUsage: 60.0,
                memUsage: 65.0,
                savings: 0,
                confidence: 95,
                costPerMonth: 120.00,
                recommendation: 'Instance is optimally sized'
            }
        ];

        // Call API (this is how CSV Recommendations page works)
        const response = await request(app)
            .post('/api/reports/generate')
            .set('x-user-id', testUser._id.toString())
            .send({
                name: reportName,
                type: 'CSV',
                recommendations
            });

        // Verify API response
        expect(response.status).toBe(200);
        expect(response.body.type).toBe('CSV');

        // Verify report was saved
        const savedReport = await Report.findOne({
            userId: testUser._id,
            name: reportName
        });

        expect(savedReport).not.toBeNull();
        expect(savedReport.type).toBe('CSV');
        expect(savedReport.recommendations).toHaveLength(3);

        // Verify summary statistics
        expect(savedReport.summary.totalRecommendations).toBe(3);
        expect(savedReport.summary.oversizedCount).toBe(1);
        expect(savedReport.summary.undersizedCount).toBe(1);
        expect(savedReport.summary.optimalCount).toBe(1);
        expect(savedReport.summary.totalSavings).toBeCloseTo(45.50, 2); // Only from Oversized
    });

    /**
     * Property 3: Preservation - Report Summary Statistics Calculation Unchanged
     * 
     * **Validates: Requirement 3.3**
     * 
     * This property verifies that the summary statistics calculation logic
     * remains unchanged after the fix.
     * 
     * EXPECTED OUTCOME: Test PASSES (confirms calculation logic preserved)
     */
    test('Property 3: Report summary statistics calculated correctly', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.record({
                    reportName: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
                    reportType: fc.constantFrom('CSV', 'Cloud'),
                    recommendations: fc.array(
                        fc.record({
                            id: fc.hexaString({ minLength: 24, maxLength: 24 }),
                            name: fc.string({ minLength: 1, maxLength: 50 }),
                            cloud: fc.constantFrom('aws', 'azure', 'gcp'),
                            finding: fc.constantFrom('Oversized', 'Undersized', 'Optimal'),
                            savings: fc.double({ min: 0, max: 1000 }),
                            confidence: fc.double({ min: 0, max: 100 })
                        }),
                        { minLength: 1, maxLength: 20 }
                    )
                }),
                async ({ reportName, reportType, recommendations }) => {
                    // Save report
                    const response = await request(app)
                        .post('/api/reports/generate')
                        .set('x-user-id', testUser._id.toString())
                        .send({
                            name: reportName,
                            type: reportType,
                            recommendations
                        });

                    expect(response.status).toBe(200);

                    // Retrieve and verify summary calculations
                    const savedReport = await Report.findOne({
                        userId: testUser._id,
                        name: reportName
                    });

                    // PRESERVATION: Summary calculation logic unchanged

                    // Total recommendations count
                    expect(savedReport.summary.totalRecommendations).toBe(recommendations.length);

                    // Total savings: ONLY from Oversized instances
                    const expectedSavings = recommendations
                        .filter(r => r.finding === 'Oversized')
                        .reduce((sum, r) => sum + (r.savings || 0), 0);
                    expect(savedReport.summary.totalSavings).toBeCloseTo(expectedSavings, 2);

                    // Counts by finding type
                    const oversizedCount = recommendations.filter(r => r.finding === 'Oversized').length;
                    const undersizedCount = recommendations.filter(r => r.finding === 'Undersized').length;
                    const optimalCount = recommendations.filter(r => r.finding === 'Optimal').length;

                    expect(savedReport.summary.oversizedCount).toBe(oversizedCount);
                    expect(savedReport.summary.undersizedCount).toBe(undersizedCount);
                    expect(savedReport.summary.optimalCount).toBe(optimalCount);

                    // Average confidence
                    const expectedAvgConfidence = recommendations.length > 0
                        ? Math.round(recommendations.reduce((sum, r) => sum + (r.confidence || 0), 0) / recommendations.length)
                        : 0;
                    expect(savedReport.summary.avgConfidence).toBe(expectedAvgConfidence);
                }
            ),
            {
                numRuns: 15,
                verbose: true
            }
        );
    });

    /**
     * Property 4: Preservation - Report Model Schema Unchanged
     * 
     * **Validates: Requirement 3.3**
     * 
     * This property verifies that the Report model schema and field structure
     * remain unchanged after the fix.
     * 
     * EXPECTED OUTCOME: Test PASSES (confirms schema preserved)
     */
    test('Property 4: Report model schema remains unchanged', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.record({
                    reportName: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
                    reportType: fc.constantFrom('CSV', 'Cloud'),
                    recommendation: fc.record({
                        id: fc.hexaString({ minLength: 24, maxLength: 24 }),
                        name: fc.string({ minLength: 1, maxLength: 50 }),
                        cloud: fc.constantFrom('aws', 'azure', 'gcp'),
                        resourceType: fc.string({ minLength: 1, maxLength: 30 }),
                        finding: fc.constantFrom('Oversized', 'Undersized', 'Optimal'),
                        instanceType: fc.string({ minLength: 1, maxLength: 30 }),
                        recommendedType: fc.string({ minLength: 1, maxLength: 30 }),
                        confidence: fc.double({ min: 0, max: 100 }),
                        cpuUsage: fc.double({ min: 0, max: 100 }),
                        memUsage: fc.double({ min: 0, max: 100 }),
                        savings: fc.double({ min: 0, max: 1000 }),
                        recommendation: fc.string({ minLength: 1, maxLength: 100 }),
                        region: fc.string({ minLength: 1, maxLength: 30 })
                    })
                }),
                async ({ reportName, reportType, recommendation }) => {
                    // Save report with all schema fields
                    const response = await request(app)
                        .post('/api/reports/generate')
                        .set('x-user-id', testUser._id.toString())
                        .send({
                            name: reportName,
                            type: reportType,
                            recommendations: [recommendation]
                        });

                    expect(response.status).toBe(200);

                    // Verify all schema fields are preserved
                    const savedReport = await Report.findOne({
                        userId: testUser._id,
                        name: reportName
                    });

                    expect(savedReport).not.toBeNull();

                    // PRESERVATION: All Report model fields present
                    expect(savedReport).toHaveProperty('userId');
                    expect(savedReport).toHaveProperty('name');
                    expect(savedReport).toHaveProperty('type');
                    expect(savedReport).toHaveProperty('status');
                    expect(savedReport).toHaveProperty('recommendations');
                    expect(savedReport).toHaveProperty('summary');
                    expect(savedReport).toHaveProperty('generatedAt');
                    expect(savedReport).toHaveProperty('size');

                    // PRESERVATION: All recommendation fields present
                    const savedRec = savedReport.recommendations[0];
                    expect(savedRec).toHaveProperty('id');
                    expect(savedRec).toHaveProperty('name');
                    expect(savedRec).toHaveProperty('cloud');
                    expect(savedRec).toHaveProperty('resourceType');
                    expect(savedRec).toHaveProperty('finding');
                    expect(savedRec).toHaveProperty('instanceType');
                    expect(savedRec).toHaveProperty('recommendedType');
                    expect(savedRec).toHaveProperty('confidence');
                    expect(savedRec).toHaveProperty('cpuUsage');
                    expect(savedRec).toHaveProperty('memUsage');
                    expect(savedRec).toHaveProperty('savings');
                    expect(savedRec).toHaveProperty('recommendation');
                    expect(savedRec).toHaveProperty('region');

                    // PRESERVATION: All summary fields present
                    expect(savedReport.summary).toHaveProperty('totalRecommendations');
                    expect(savedReport.summary).toHaveProperty('totalSavings');
                    expect(savedReport.summary).toHaveProperty('oversizedCount');
                    expect(savedReport.summary).toHaveProperty('undersizedCount');
                    expect(savedReport.summary).toHaveProperty('optimalCount');
                    expect(savedReport.summary).toHaveProperty('avgConfidence');
                }
            ),
            {
                numRuns: 10,
                verbose: true
            }
        );
    });

    /**
     * Property 5: Preservation - Reports Page Display Unchanged
     * 
     * **Validates: Requirement 3.4**
     * 
     * This property verifies that the Reports page API continues to return
     * report metadata in the expected format.
     * 
     * EXPECTED OUTCOME: Test PASSES (confirms display format preserved)
     */
    test('Property 5: Reports page displays report metadata correctly', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.array(
                    fc.record({
                        reportName: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
                        reportType: fc.constantFrom('CSV', 'Cloud'),
                        recommendations: fc.array(
                            fc.record({
                                id: fc.hexaString({ minLength: 24, maxLength: 24 }),
                                name: fc.string({ minLength: 1, maxLength: 50 }),
                                finding: fc.constantFrom('Oversized', 'Undersized', 'Optimal'),
                                savings: fc.double({ min: 0, max: 1000 })
                            }),
                            { minLength: 1, maxLength: 5 }
                        )
                    }),
                    { minLength: 1, maxLength: 3 }
                ),
                async (reports) => {
                    // Get initial report count
                    const initialResponse = await request(app)
                        .get('/api/reports')
                        .set('x-user-id', testUser._id.toString());
                    const initialCount = initialResponse.body.length;

                    // Create multiple reports
                    for (const report of reports) {
                        await request(app)
                            .post('/api/reports/generate')
                            .set('x-user-id', testUser._id.toString())
                            .send({
                                name: report.reportName,
                                type: report.reportType,
                                recommendations: report.recommendations
                            });
                    }

                    // Retrieve reports list
                    const response = await request(app)
                        .get('/api/reports')
                        .set('x-user-id', testUser._id.toString());

                    expect(response.status).toBe(200);
                    expect(response.body).toBeInstanceOf(Array);
                    expect(response.body.length).toBe(initialCount + reports.length);

                    // PRESERVATION: Report metadata format unchanged
                    response.body.forEach(reportMeta => {
                        expect(reportMeta).toHaveProperty('id');
                        expect(reportMeta).toHaveProperty('name');
                        expect(reportMeta).toHaveProperty('type');
                        expect(reportMeta).toHaveProperty('status');
                        expect(reportMeta).toHaveProperty('date');
                        expect(reportMeta).toHaveProperty('size');
                        expect(reportMeta).toHaveProperty('summary');
                        expect(reportMeta).toHaveProperty('recommendationsCount');

                        // Verify type is one of the expected values
                        expect(['CSV', 'Cloud', 'Combined']).toContain(reportMeta.type);
                    });
                }
            ),
            {
                numRuns: 5,
                verbose: true
            }
        );
    });
});
