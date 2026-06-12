-- Migration: Add Complete Pricing Tables for 100% Coverage
-- Date: 2026-03-08
-- Description: Adds all missing pricing tables for AWS, Azure, and GCP

-- ============================================================================
-- AWS PRICING TABLES
-- ============================================================================

-- AWS Spot Pricing
CREATE TABLE IF NOT EXISTS aws_spot_pricing (
    id SERIAL PRIMARY KEY,
    region TEXT NOT NULL,
    instance_type TEXT NOT NULL,
    os TEXT NOT NULL,
    availability_zone TEXT,
    spot_price NUMERIC(10, 6),
    savings_over_ondemand NUMERIC(5, 2), -- Percentage
    currency TEXT DEFAULT 'USD',
    last_updated TIMESTAMP DEFAULT NOW(),
    UNIQUE(region, instance_type, os, availability_zone)
);

CREATE INDEX idx_aws_spot_region_type ON aws_spot_pricing(region, instance_type);
CREATE INDEX idx_aws_spot_os ON aws_spot_pricing(os);

-- AWS Reserved Instance Pricing
CREATE TABLE IF NOT EXISTS aws_reserved_pricing (
    id SERIAL PRIMARY KEY,
    region TEXT NOT NULL,
    instance_type TEXT NOT NULL,
    os TEXT NOT NULL,
    tenancy TEXT NOT NULL,
    term_length INTEGER NOT NULL, -- 1 or 3 years
    payment_option TEXT NOT NULL, -- 'All Upfront', 'Partial Upfront', 'No Upfront'
    upfront_cost NUMERIC(10, 2),
    hourly_cost NUMERIC(10, 6),
    effective_hourly_cost NUMERIC(10, 6), -- (upfront / hours) + hourly
    savings_over_ondemand NUMERIC(5, 2), -- Percentage
    currency TEXT DEFAULT 'USD',
    last_updated TIMESTAMP DEFAULT NOW(),
    UNIQUE(region, instance_type, os, tenancy, term_length, payment_option)
);

CREATE INDEX idx_aws_reserved_region_type ON aws_reserved_pricing(region, instance_type);
CREATE INDEX idx_aws_reserved_term ON aws_reserved_pricing(term_length);

-- AWS Savings Plans
CREATE TABLE IF NOT EXISTS aws_savings_plans (
    id SERIAL PRIMARY KEY,
    region TEXT NOT NULL,
    instance_family TEXT NOT NULL, -- e.g., 'm5', 'c5'
    term_length INTEGER NOT NULL, -- 1 or 3 years
    payment_option TEXT NOT NULL,
    commitment_hourly NUMERIC(10, 2), -- Hourly commitment amount
    discount_percentage NUMERIC(5, 2),
    plan_type TEXT NOT NULL, -- 'Compute', 'EC2 Instance'
    currency TEXT DEFAULT 'USD',
    last_updated TIMESTAMP DEFAULT NOW(),
    UNIQUE(region, instance_family, term_length, payment_option, plan_type)
);

CREATE INDEX idx_aws_savings_family ON aws_savings_plans(instance_family);

-- ============================================================================
-- AZURE PRICING TABLES
-- ============================================================================

-- Azure Reserved VM Pricing
CREATE TABLE IF NOT EXISTS azure_reserved_pricing (
    id SERIAL PRIMARY KEY,
    region TEXT NOT NULL,
    vm_size TEXT NOT NULL,
    os TEXT NOT NULL,
    term_length INTEGER NOT NULL, -- 1 or 3 years
    payment_option TEXT NOT NULL, -- 'Upfront', 'Monthly'
    upfront_cost NUMERIC(10, 2),
    monthly_cost NUMERIC(10, 2),
    effective_hourly_cost NUMERIC(10, 6),
    savings_over_payg NUMERIC(5, 2), -- Percentage over Pay-As-You-Go
    currency TEXT DEFAULT 'USD',
    last_updated TIMESTAMP DEFAULT NOW(),
    UNIQUE(region, vm_size, os, term_length, payment_option)
);

CREATE INDEX idx_azure_reserved_region_size ON azure_reserved_pricing(region, vm_size);
CREATE INDEX idx_azure_reserved_term ON azure_reserved_pricing(term_length);

-- Azure Hybrid Benefit
CREATE TABLE IF NOT EXISTS azure_hybrid_benefit (
    id SERIAL PRIMARY KEY,
    region TEXT NOT NULL,
    vm_size TEXT NOT NULL,
    os TEXT NOT NULL, -- Only 'Windows' and 'SQL Server'
    license_type TEXT NOT NULL, -- 'Windows Server', 'SQL Server Standard', 'SQL Server Enterprise'
    base_cost NUMERIC(10, 6),
    hybrid_benefit_cost NUMERIC(10, 6),
    savings_amount NUMERIC(10, 6),
    savings_percentage NUMERIC(5, 2),
    currency TEXT DEFAULT 'USD',
    last_updated TIMESTAMP DEFAULT NOW(),
    UNIQUE(region, vm_size, os, license_type)
);

CREATE INDEX idx_azure_hybrid_region_size ON azure_hybrid_benefit(region, vm_size);

-- ============================================================================
-- GCP PRICING TABLES
-- ============================================================================

-- GCP Preemptible VM Pricing
CREATE TABLE IF NOT EXISTS gcp_preemptible_pricing (
    id SERIAL PRIMARY KEY,
    region TEXT NOT NULL,
    instance_type TEXT NOT NULL,
    os TEXT NOT NULL,
    preemptible_price NUMERIC(10, 6),
    ondemand_price NUMERIC(10, 6),
    savings_amount NUMERIC(10, 6),
    savings_percentage NUMERIC(5, 2),
    currency TEXT DEFAULT 'USD',
    last_updated TIMESTAMP DEFAULT NOW(),
    UNIQUE(region, instance_type, os)
);

CREATE INDEX idx_gcp_preempt_region_type ON gcp_preemptible_pricing(region, instance_type);
CREATE INDEX idx_gcp_preempt_os ON gcp_preemptible_pricing(os);

-- GCP Committed Use Discounts
CREATE TABLE IF NOT EXISTS gcp_committed_pricing (
    id SERIAL PRIMARY KEY,
    region TEXT NOT NULL,
    instance_type TEXT NOT NULL,
    os TEXT NOT NULL,
    term_length INTEGER NOT NULL, -- 1 or 3 years
    committed_price NUMERIC(10, 6),
    ondemand_price NUMERIC(10, 6),
    savings_amount NUMERIC(10, 6),
    savings_percentage NUMERIC(5, 2),
    currency TEXT DEFAULT 'USD',
    last_updated TIMESTAMP DEFAULT NOW(),
    UNIQUE(region, instance_type, os, term_length)
);

CREATE INDEX idx_gcp_committed_region_type ON gcp_committed_pricing(region, instance_type);
CREATE INDEX idx_gcp_committed_term ON gcp_committed_pricing(term_length);

-- GCP OS-Specific Pricing (CRITICAL for accuracy)
CREATE TABLE IF NOT EXISTS gcp_os_pricing (
    id SERIAL PRIMARY KEY,
    region TEXT NOT NULL,
    instance_type TEXT NOT NULL,
    os_type TEXT NOT NULL, -- 'RHEL', 'RHEL_SAP', 'SUSE', 'SUSE_SAP', 'Ubuntu_Pro', 'Windows'
    os_version TEXT, -- e.g., 'RHEL 8', 'SUSE 15', 'Windows Server 2022'
    base_vm_price NUMERIC(10, 6), -- Base VM cost
    os_premium NUMERIC(10, 6), -- Additional OS cost
    total_price NUMERIC(10, 6), -- base_vm_price + os_premium
    currency TEXT DEFAULT 'USD',
    last_updated TIMESTAMP DEFAULT NOW(),
    UNIQUE(region, instance_type, os_type, os_version)
);

CREATE INDEX idx_gcp_os_region_type ON gcp_os_pricing(region, instance_type);
CREATE INDEX idx_gcp_os_type ON gcp_os_pricing(os_type);

-- ============================================================================
-- MISSING REGIONS TABLES
-- ============================================================================

-- AWS Missing Regions (extend existing aws_pricing table)
-- Will be populated by fetch scripts

-- ============================================================================
-- METADATA TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS pricing_metadata (
    id SERIAL PRIMARY KEY,
    cloud_provider TEXT NOT NULL,
    table_name TEXT NOT NULL,
    last_updated TIMESTAMP DEFAULT NOW(),
    record_count INTEGER DEFAULT 0,
    data_source TEXT, -- 'API', 'Manual', 'Estimated'
    notes TEXT,
    UNIQUE(cloud_provider, table_name)
);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE aws_spot_pricing IS 'AWS Spot instance pricing - can save 70-90%';
COMMENT ON TABLE aws_reserved_pricing IS 'AWS Reserved Instance pricing - can save 30-75%';
COMMENT ON TABLE aws_savings_plans IS 'AWS Savings Plans - can save 20-72%';
COMMENT ON TABLE azure_reserved_pricing IS 'Azure Reserved VM pricing - can save 30-65%';
COMMENT ON TABLE azure_hybrid_benefit IS 'Azure Hybrid Benefit savings for Windows/SQL';
COMMENT ON TABLE gcp_preemptible_pricing IS 'GCP Preemptible VM pricing - can save 60-91%';
COMMENT ON TABLE gcp_committed_pricing IS 'GCP Committed Use Discounts - can save 25-70%';
COMMENT ON TABLE gcp_os_pricing IS 'GCP OS-specific pricing (RHEL, SUSE, Ubuntu Pro, Windows)';

-- ============================================================================
-- INITIAL METADATA
-- ============================================================================

INSERT INTO pricing_metadata (cloud_provider, table_name, record_count, data_source, notes)
VALUES 
    ('AWS', 'aws_spot_pricing', 0, 'Pending', 'To be populated'),
    ('AWS', 'aws_reserved_pricing', 0, 'Pending', 'To be populated'),
    ('AWS', 'aws_savings_plans', 0, 'Pending', 'To be populated'),
    ('Azure', 'azure_reserved_pricing', 0, 'Pending', 'To be populated'),
    ('Azure', 'azure_hybrid_benefit', 0, 'Pending', 'To be populated'),
    ('GCP', 'gcp_preemptible_pricing', 0, 'Pending', 'To be populated'),
    ('GCP', 'gcp_committed_pricing', 0, 'Pending', 'To be populated'),
    ('GCP', 'gcp_os_pricing', 0, 'Pending', 'To be populated')
ON CONFLICT (cloud_provider, table_name) DO NOTHING;
