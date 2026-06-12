#!/bin/bash

# Quick Start Script: Complete Database Population
# This script automates the entire process of adding all missing pricing data

set -e  # Exit on error

echo "═══════════════════════════════════════════════════════════════"
echo "  COMPLETE DATABASE POPULATION - QUICK START"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Check prerequisites
echo "Step 1: Checking prerequisites..."
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js not found. Please install Node.js 16+${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Node.js found: $(node --version)${NC}"

# Check PostgreSQL
if ! command -v psql &> /dev/null; then
    echo -e "${RED}❌ PostgreSQL not found. Please install PostgreSQL 12+${NC}"
    exit 1
fi
echo -e "${GREEN}✅ PostgreSQL found${NC}"

# Check .env file
if [ ! -f "../.env" ]; then
    echo -e "${RED}❌ .env file not found. Please create it with API credentials${NC}"
    exit 1
fi
echo -e "${GREEN}✅ .env file found${NC}"

# Check database connection
if ! psql $POSTGRES_URL -c "SELECT 1" &> /dev/null; then
    echo -e "${RED}❌ Cannot connect to database. Check POSTGRES_URL in .env${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Database connection successful${NC}"

echo ""

# Step 2: Install dependencies
echo "Step 2: Installing dependencies..."
echo ""

npm install aws-sdk @azure/arm-compute @azure/ms-rest-nodeauth @google-cloud/billing

echo -e "${GREEN}✅ Dependencies installed${NC}"
echo ""

# Step 3: Run database migrations
echo "Step 3: Running database migrations..."
echo ""

psql $POSTGRES_URL < ../migrations/add_complete_pricing_tables.sql

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Migrations completed successfully${NC}"
else
    echo -e "${RED}❌ Migrations failed${NC}"
    exit 1
fi

echo ""

# Step 4: Verify tables created
echo "Step 4: Verifying tables..."
echo ""

TABLE_COUNT=$(psql $POSTGRES_URL -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_name LIKE '%pricing%' OR table_name LIKE '%benefit%'")

if [ $TABLE_COUNT -ge 15 ]; then
    echo -e "${GREEN}✅ All pricing tables created (${TABLE_COUNT} tables)${NC}"
else
    echo -e "${YELLOW}⚠️  Expected 15+ tables, found ${TABLE_COUNT}${NC}"
fi

echo ""

# Step 5: Ask user confirmation
echo "═══════════════════════════════════════════════════════════════"
echo "  READY TO FETCH DATA"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "This will:"
echo "  • Fetch ~695,000 pricing records"
echo "  • Take 4-6 hours to complete"
echo "  • Use AWS, Azure, and GCP APIs"
echo "  • Increase database size by ~3 GB"
echo ""
read -p "Do you want to continue? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
    echo "Aborted by user"
    exit 0
fi

echo ""

# Step 6: Fetch all data
echo "Step 6: Fetching all pricing data..."
echo ""
echo "This will take 4-6 hours. You can monitor progress in real-time."
echo "Press Ctrl+C to cancel (data will be saved up to that point)"
echo ""

sleep 3

node fetch_all_pricing_data.js

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Data fetching completed successfully${NC}"
else
    echo -e "${RED}❌ Data fetching failed or was interrupted${NC}"
    echo "You can resume by running: node scripts/fetch_all_pricing_data.js"
    exit 1
fi

echo ""

# Step 7: Verify coverage
echo "Step 7: Verifying coverage..."
echo ""

node verify_complete_coverage.js

echo ""

# Step 8: Summary
echo "═══════════════════════════════════════════════════════════════"
echo "  COMPLETION SUMMARY"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Get total record count
TOTAL_RECORDS=$(psql $POSTGRES_URL -t -c "
    SELECT SUM(record_count) 
    FROM pricing_metadata
")

echo "Total pricing records: $(echo $TOTAL_RECORDS | xargs | numfmt --grouping)"
echo ""

# Get coverage by cloud
AWS_RECORDS=$(psql $POSTGRES_URL -t -c "
    SELECT SUM(record_count) 
    FROM pricing_metadata 
    WHERE cloud_provider = 'AWS'
")

AZURE_RECORDS=$(psql $POSTGRES_URL -t -c "
    SELECT SUM(record_count) 
    FROM pricing_metadata 
    WHERE cloud_provider = 'Azure'
")

GCP_RECORDS=$(psql $POSTGRES_URL -t -c "
    SELECT SUM(record_count) 
    FROM pricing_metadata 
    WHERE cloud_provider = 'GCP'
")

echo "AWS records:   $(echo $AWS_RECORDS | xargs | numfmt --grouping)"
echo "Azure records: $(echo $AZURE_RECORDS | xargs | numfmt --grouping)"
echo "GCP records:   $(echo $GCP_RECORDS | xargs | numfmt --grouping)"
echo ""

echo -e "${GREEN}✅ DATABASE POPULATION COMPLETE!${NC}"
echo ""
echo "Next steps:"
echo "  1. Update application code to use new pricing tables"
echo "  2. Test recommendations with different pricing models"
echo "  3. Set up automated pricing updates (see README)"
echo ""
echo "═══════════════════════════════════════════════════════════════"
