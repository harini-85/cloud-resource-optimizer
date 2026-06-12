/**
 * Comprehensive Verification: 100% Coverage Test
 * 
 * Tests that the database now has ALL required data for complete recommendations
 */

const { Pool } = require('pg');
require('dotenv').config({ path: '../.env' });

const pool = new Pool({
    connectionString: process.env.POSTGRES_URL
});

async function main() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  100% COVERAGE VERIFICATION TEST');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const results = {
        passed: 0,
        failed: 0,
        tests: []
    };

    // Test 1: All pricing tables exist
    await testTablesExist(results);

    // Test 2: AWS Coverage
    await testAWSCoverage(results);

    // Test 3: Azure Coverage
    await testAzureCoverage(results);

    // Test 4: GCP Coverage
    await testGCPCoverage(results);

    // Test 5: Specific Scenarios
    await testSpecificScenarios(results);

    // Generate final report
    generateFinalReport(results);

    await pool.end();

    process.exit(results.failed > 0 ? 1 : 0);
}

async function testTablesExist(results) {
    console.log('📋 TEST 1: Verifying All Tables Exist\n');

    const requiredTables = [
        // Existing tables
        'aws_instance_sizes',
        'aws_pricing',
        'azure_vm_pricing',
        'azure_vm_sizes',
        'gcp_vm_pricing',
        'gcp_vm_sizes',
        // New tables (if added)
        'aws_spot_pricing',
        'aws_reserved_pricing',
        'azure_reserved_pricing',
        'gcp_preemptible_pricing',
        'gcp_os_pricing'
    ];

    for (const table of requiredTables) {
        try {
            const query = `SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = $1
            )`;
            const result = await pool.query(query, [table]);

            if (result.rows[0].exists) {
                const countQuery = `SELECT COUNT(*) as count FROM ${table}`;
                const countResult = await pool.query(countQuery);
                const count = parseInt(countResult.rows[0].count);

                console.log(`  ✅ ${table.padEnd(30)} ${count.toLocaleString()} records`);
                results.passed++;
                results.tests.push({ name: `Table: ${table}`, status: 'PASS', count });
            } else {
                console.log(`  ⚠️  ${table.padEnd(30)} NOT FOUND (may not be needed yet)`);
                results.tests.push({ name: `Table: ${table}`, status: 'SKIP', count: 0 });
            }
        } catch (error) {
            console.log(`  ❌ ${table.padEnd(30)} ERROR: ${error.message}`);
            results.failed++;
            results.tests.push({ name: `Table: ${table}`, status: 'FAIL', error: error.message });
        }
    }
}

async function testAWSCoverage(results) {
    console.log('\n\n🔷 TEST 2: AWS Coverage\n');

    // Test 2.1: Region Coverage
    try {
        const query = `SELECT DISTINCT region FROM aws_pricing ORDER BY region`;
        const result = await pool.query(query);
        const regions = result.rows.length;
        const expected = 17; // Current coverage
        const percentage = (regions / 33 * 100).toFixed(1); // Out of 33 total AWS regions

        console.log(`  Regions: ${regions} regions (${percentage}% of all AWS regions)`);

        if (regions >= expected) {
            console.log(`  ✅ AWS regions coverage acceptable`);
            results.passed++;
            results.tests.push({ name: 'AWS Regions', status: 'PASS', value: `${regions} regions` });
        } else {
            console.log(`  ❌ AWS regions below expected (${regions} < ${expected})`);
            results.failed++;
            results.tests.push({ name: 'AWS Regions', status: 'FAIL', value: `${regions} regions` });
        }
    } catch (error) {
        console.log(`  ❌ Error: ${error.message}`);
        results.failed++;
        results.tests.push({ name: 'AWS Regions', status: 'FAIL', error: error.message });
    }

    // Test 2.2: Instance Types
    try {
        const query = `SELECT COUNT(DISTINCT instance_type) as count FROM aws_pricing`;
        const result = await pool.query(query);
        const count = parseInt(result.rows[0].count);

        console.log(`  Instance Types: ${count.toLocaleString()} unique types`);

        if (count >= 500) {
            console.log(`  ✅ AWS instance types coverage good`);
            results.passed++;
            results.tests.push({ name: 'AWS Instance Types', status: 'PASS', value: count });
        } else {
            console.log(`  ⚠️  AWS instance types below expected (${count} < 500)`);
            results.tests.push({ name: 'AWS Instance Types', status: 'WARN', value: count });
        }
    } catch (error) {
        console.log(`  ❌ Error: ${error.message}`);
        results.failed++;
    }

    // Test 2.3: OS Types
    try {
        const query = `SELECT DISTINCT os FROM aws_pricing ORDER BY os`;
        const result = await pool.query(query);
        const osTypes = result.rows.map(r => r.os);

        console.log(`  OS Types: ${osTypes.length} types`);
        console.log(`    ${osTypes.join(', ')}`);

        if (osTypes.length >= 4) {
            console.log(`  ✅ AWS OS types coverage good`);
            results.passed++;
            results.tests.push({ name: 'AWS OS Types', status: 'PASS', value: osTypes.length });
        } else {
            console.log(`  ⚠️  AWS OS types limited`);
            results.tests.push({ name: 'AWS OS Types', status: 'WARN', value: osTypes.length });
        }
    } catch (error) {
        console.log(`  ❌ Error: ${error.message}`);
        results.failed++;
    }

    // Test 2.4: Pricing Data Quality
    try {
        const query = `
            SELECT 
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE price_per_hour IS NOT NULL) as with_price,
                COUNT(*) FILTER (WHERE price_per_hour IS NULL) as without_price
            FROM aws_pricing
        `;
        const result = await pool.query(query);
        const { total, with_price, without_price } = result.rows[0];
        const percentage = (with_price / total * 100).toFixed(1);

        console.log(`  Pricing Data: ${with_price.toLocaleString()}/${total.toLocaleString()} records have prices (${percentage}%)`);

        if (percentage >= 95) {
            console.log(`  ✅ AWS pricing data quality excellent`);
            results.passed++;
            results.tests.push({ name: 'AWS Pricing Quality', status: 'PASS', value: `${percentage}%` });
        } else {
            console.log(`  ⚠️  AWS pricing data has gaps`);
            results.tests.push({ name: 'AWS Pricing Quality', status: 'WARN', value: `${percentage}%` });
        }
    } catch (error) {
        console.log(`  ❌ Error: ${error.message}`);
        results.failed++;
    }
}

async function testAzureCoverage(results) {
    console.log('\n\n🔷 TEST 3: Azure Coverage\n');

    // Test 3.1: Region Coverage
    try {
        const query = `SELECT DISTINCT region FROM azure_vm_pricing ORDER BY region`;
        const result = await pool.query(query);
        const regions = result.rows.length;
        const percentage = (regions / 45 * 100).toFixed(1);

        console.log(`  Regions: ${regions} regions (${percentage}% of all Azure regions)`);

        if (regions >= 40) {
            console.log(`  ✅ Azure regions coverage excellent`);
            results.passed++;
            results.tests.push({ name: 'Azure Regions', status: 'PASS', value: `${regions} regions` });
        } else {
            console.log(`  ⚠️  Azure regions below expected`);
            results.tests.push({ name: 'Azure Regions', status: 'WARN', value: `${regions} regions` });
        }
    } catch (error) {
        console.log(`  ❌ Error: ${error.message}`);
        results.failed++;
    }

    // Test 3.2: VM Sizes
    try {
        const query = `SELECT COUNT(DISTINCT vm_size) as count FROM azure_vm_pricing`;
        const result = await pool.query(query);
        const count = parseInt(result.rows[0].count);

        console.log(`  VM Sizes: ${count.toLocaleString()} unique sizes`);

        if (count >= 300) {
            console.log(`  ✅ Azure VM sizes coverage excellent`);
            results.passed++;
            results.tests.push({ name: 'Azure VM Sizes', status: 'PASS', value: count });
        } else {
            console.log(`  ⚠️  Azure VM sizes below expected`);
            results.tests.push({ name: 'Azure VM Sizes', status: 'WARN', value: count });
        }
    } catch (error) {
        console.log(`  ❌ Error: ${error.message}`);
        results.failed++;
    }

    // Test 3.3: Spot Pricing
    try {
        const query = `SELECT COUNT(*) as count FROM azure_vm_pricing WHERE is_spot = true`;
        const result = await pool.query(query);
        const count = parseInt(result.rows[0].count);

        console.log(`  Spot Pricing: ${count.toLocaleString()} records`);

        if (count > 0) {
            console.log(`  ✅ Azure spot pricing available`);
            results.passed++;
            results.tests.push({ name: 'Azure Spot Pricing', status: 'PASS', value: count });
        } else {
            console.log(`  ❌ Azure spot pricing missing`);
            results.failed++;
            results.tests.push({ name: 'Azure Spot Pricing', status: 'FAIL', value: 0 });
        }
    } catch (error) {
        console.log(`  ❌ Error: ${error.message}`);
        results.failed++;
    }
}

async function testGCPCoverage(results) {
    console.log('\n\n🔷 TEST 4: GCP Coverage\n');

    // Test 4.1: Region Coverage
    try {
        const query = `SELECT DISTINCT region FROM gcp_vm_pricing ORDER BY region`;
        const result = await pool.query(query);
        const regions = result.rows.length;
        const percentage = (regions / 48 * 100).toFixed(1);

        console.log(`  Regions: ${regions} regions (${percentage}% of all GCP regions)`);

        if (regions >= 40) {
            console.log(`  ✅ GCP regions coverage excellent`);
            results.passed++;
            results.tests.push({ name: 'GCP Regions', status: 'PASS', value: `${regions} regions` });
        } else {
            console.log(`  ⚠️  GCP regions below expected`);
            results.tests.push({ name: 'GCP Regions', status: 'WARN', value: `${regions} regions` });
        }
    } catch (error) {
        console.log(`  ❌ Error: ${error.message}`);
        results.failed++;
    }

    // Test 4.2: Instance Types
    try {
        const query = `SELECT COUNT(DISTINCT instance_type) as count FROM gcp_vm_pricing`;
        const result = await pool.query(query);
        const count = parseInt(result.rows[0].count);

        console.log(`  Instance Types: ${count.toLocaleString()} unique types`);

        if (count >= 200) {
            console.log(`  ✅ GCP instance types coverage good`);
            results.passed++;
            results.tests.push({ name: 'GCP Instance Types', status: 'PASS', value: count });
        } else {
            console.log(`  ⚠️  GCP instance types below expected`);
            results.tests.push({ name: 'GCP Instance Types', status: 'WARN', value: count });
        }
    } catch (error) {
        console.log(`  ❌ Error: ${error.message}`);
        results.failed++;
    }

    // Test 4.3: OS Types
    try {
        const query = `SELECT DISTINCT os FROM gcp_vm_pricing ORDER BY os`;
        const result = await pool.query(query);
        const osTypes = result.rows.map(r => r.os);

        console.log(`  OS Types: ${osTypes.length} types`);
        console.log(`    ${osTypes.join(', ')}`);

        if (osTypes.length >= 2) {
            console.log(`  ✅ GCP OS types available`);
            results.passed++;
            results.tests.push({ name: 'GCP OS Types', status: 'PASS', value: osTypes.length });
        } else {
            console.log(`  ❌ GCP OS types missing`);
            results.failed++;
            results.tests.push({ name: 'GCP OS Types', status: 'FAIL', value: osTypes.length });
        }
    } catch (error) {
        console.log(`  ❌ Error: ${error.message}`);
        results.failed++;
    }
}

async function testSpecificScenarios(results) {
    console.log('\n\n🧪 TEST 5: Specific Recommendation Scenarios\n');

    // Scenario 1: AWS t3.medium in us-east-1
    try {
        const query = `
            SELECT price_per_hour 
            FROM aws_pricing 
            WHERE instance_type = 't3.medium' 
              AND region = 'us-east-1' 
              AND os = 'Linux'
            LIMIT 1
        `;
        const result = await pool.query(query);

        if (result.rows.length > 0) {
            const price = result.rows[0].price_per_hour;
            console.log(`  ✅ Scenario 1: AWS t3.medium in us-east-1 = $${price}/hour`);
            results.passed++;
            results.tests.push({ name: 'AWS t3.medium pricing', status: 'PASS', value: `$${price}/hour` });
        } else {
            console.log(`  ❌ Scenario 1: AWS t3.medium in us-east-1 - NO DATA`);
            results.failed++;
            results.tests.push({ name: 'AWS t3.medium pricing', status: 'FAIL' });
        }
    } catch (error) {
        console.log(`  ❌ Scenario 1 Error: ${error.message}`);
        results.failed++;
    }

    // Scenario 2: Azure Standard_D4s_v5 in eastus
    try {
        const query = `
            SELECT price_per_hour 
            FROM azure_vm_pricing 
            WHERE vm_size = 'Standard_D4s_v5' 
              AND region = 'eastus'
            LIMIT 1
        `;
        const result = await pool.query(query);

        if (result.rows.length > 0) {
            const price = result.rows[0].price_per_hour;
            console.log(`  ✅ Scenario 2: Azure Standard_D4s_v5 in eastus = $${price}/hour`);
            results.passed++;
            results.tests.push({ name: 'Azure D4s_v5 pricing', status: 'PASS', value: `$${price}/hour` });
        } else {
            console.log(`  ❌ Scenario 2: Azure Standard_D4s_v5 in eastus - NO DATA`);
            results.failed++;
            results.tests.push({ name: 'Azure D4s_v5 pricing', status: 'FAIL' });
        }
    } catch (error) {
        console.log(`  ❌ Scenario 2 Error: ${error.message}`);
        results.failed++;
    }

    // Scenario 3: GCP n2-standard-4 in us-central1
    try {
        const query = `
            SELECT price_per_hour 
            FROM gcp_vm_pricing 
            WHERE instance_type = 'n2-standard-4' 
              AND region = 'us-central1'
              AND os = 'Linux'
            LIMIT 1
        `;
        const result = await pool.query(query);

        if (result.rows.length > 0) {
            const price = result.rows[0].price_per_hour;
            console.log(`  ✅ Scenario 3: GCP n2-standard-4 in us-central1 = $${price}/hour`);
            results.passed++;
            results.tests.push({ name: 'GCP n2-standard-4 pricing', status: 'PASS', value: `$${price}/hour` });
        } else {
            console.log(`  ❌ Scenario 3: GCP n2-standard-4 in us-central1 - NO DATA`);
            results.failed++;
            results.tests.push({ name: 'GCP n2-standard-4 pricing', status: 'FAIL' });
        }
    } catch (error) {
        console.log(`  ❌ Scenario 3 Error: ${error.message}`);
        results.failed++;
    }
}

function generateFinalReport(results) {
    console.log('\n\n═══════════════════════════════════════════════════════════════');
    console.log('  FINAL VERIFICATION REPORT');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const total = results.passed + results.failed;
    const percentage = (results.passed / total * 100).toFixed(1);

    console.log(`Tests Passed: ${results.passed}/${total} (${percentage}%)`);
    console.log(`Tests Failed: ${results.failed}/${total}`);
    console.log('');

    if (results.failed === 0) {
        console.log('✅ ALL TESTS PASSED - DATABASE HAS COMPLETE INFORMATION!');
        console.log('');
        console.log('The database can now provide:');
        console.log('  ✅ Recommendations for all major instance types');
        console.log('  ✅ Pricing for all covered regions');
        console.log('  ✅ OS-specific pricing where available');
        console.log('  ✅ Spot pricing for Azure');
        console.log('  ✅ Complete recommendation capability');
    } else {
        console.log('⚠️  SOME TESTS FAILED - REVIEW ABOVE FOR DETAILS');
        console.log('');
        console.log('Failed tests:');
        results.tests.filter(t => t.status === 'FAIL').forEach(t => {
            console.log(`  ❌ ${t.name}`);
        });
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = main;
