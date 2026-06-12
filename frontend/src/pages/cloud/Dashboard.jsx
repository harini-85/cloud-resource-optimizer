import { useState, useEffect } from 'react';
import { Server, RefreshCw, Trash2, AlertTriangle, ArrowUpRight, TrendingDown } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../../services/api';
import * as localStorageService from '../../services/localStorageService';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import CloudAccessWarning from '../../components/common/CloudAccessWarning';
import { AnimatedSection, AnimatedContainer, AnimatedItem } from '../../components/animations/AnimatedSection';

const AZ = {
    stat: {
        wrapper: {
            background: '#fff', border: '1px solid var(--az-border)', borderRadius: 6,
            padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 8,
        },
        icon: (color) => ({
            width: 36, height: 36, borderRadius: 6, display: 'flex',
            alignItems: 'center', justifyContent: 'center', background: color, flexShrink: 0,
        }),
        label: { fontSize: 12, fontWeight: 400, color: 'var(--az-text-2)', margin: 0 },
        value: { fontSize: 28, fontWeight: 600, color: 'var(--az-text)', margin: 0, lineHeight: 1.1 },
        sub: { fontSize: 12, color: 'var(--az-text-3)', margin: 0 },
    },
};

function StatCard({ icon: Icon, iconBg, iconColor, label, value, sub, badge }) {
    return (
        <div style={AZ.stat.wrapper}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={AZ.stat.icon(iconBg)}>
                    <Icon size={18} style={{ color: iconColor }} />
                </div>
                {badge && <span style={{ fontSize: 11, background: 'var(--az-success-bg)', color: 'var(--az-success)', padding: '2px 8px', borderRadius: 10, fontWeight: 600 }}>{badge}</span>}
            </div>
            <p style={AZ.stat.label}>{label}</p>
            <p style={AZ.stat.value}>{value}</p>
            {sub && <p style={AZ.stat.sub}>{sub}</p>}
        </div>
    );
}

export default function CloudDashboard() {
    const navigate = useNavigate();
    const [resources, setResources] = useState([]);
    const [recommendations, setRecommendations] = useState([]);
    const [loading, setLoading] = useState(true);
    const [optimizationLoading, setOptimizationLoading] = useState(false);
    const [optimizationError, setOptimizationError] = useState(null);
    const [optimizationLastUpdated, setOptimizationLastUpdated] = useState(null);
    const [syncProgress, setSyncProgress] = useState({ elapsed: 0, status: '' });
    const [userId] = useState(localStorage.getItem('userId'));
    const [cloudConfigs, setCloudConfigs] = useState([]);
    const [invalidCredentials, setInvalidCredentials] = useState([]);

    useEffect(() => {
        const initializePage = async () => {
            // SECURITY: Migrate old shared data to user-specific storage
            localStorageService.migrateToUserSpecificStorage();

            // Check cloud configs first
            await checkCloudConfigs();

            // Load from localStorage
            loadResourcesFromLocalStorage();

            // Check if we need to auto-fetch
            const existingData = localStorageService.getResources();
            const needsRefresh = localStorageService.needsRefresh(5); // 5 minutes threshold

            // Auto-fetch immediately if (no data OR stale data)
            if (existingData.length === 0 || needsRefresh) {
                console.log('[Dashboard] Auto-fetching resources immediately...', {
                    noData: existingData.length === 0,
                    stale: needsRefresh
                });
                fetchResources(true); // No delay - fetch immediately
            }
        };

        initializePage();
    }, []);

    const checkCloudConfigs = async () => {
        try {
            const res = await api.get(`/cloud/config/${userId}`);
            setCloudConfigs(res.data);

            // Check for invalid credentials
            const invalid = res.data.filter(config => config.status === 'INVALID');
            setInvalidCredentials(invalid);
        } catch (e) {
            console.error('Failed to fetch cloud configs:', e);
        }
    };

    const loadResourcesFromLocalStorage = () => {
        setLoading(true);
        try {
            const fetchedResources = localStorageService.getResources();
            console.log('[Dashboard] Loaded from localStorage:', fetchedResources.length, 'resources');

            // Transform resources to use real optimization data
            const transformedResources = fetchedResources.map(resource => {
                const optimizationStatus = mapOptimizationStatus(resource);

                // Use real estimated savings from cloud providers
                let estimatedSavings = 0;

                // AWS Compute Optimizer savings
                if (resource.estimatedSavings) {
                    estimatedSavings = resource.estimatedSavings;
                }
                // Azure Advisor savings
                else if (resource.estimated_monthly_savings) {
                    estimatedSavings = resource.estimated_monthly_savings;
                }
                // GCP Recommender savings
                else if (resource.gcp_recommendation_id && resource.estimated_monthly_savings) {
                    estimatedSavings = resource.estimated_monthly_savings;
                }
                // Fallback to any generic savings field
                else if (resource.potential_monthly_savings) {
                    estimatedSavings = resource.potential_monthly_savings;
                }

                return {
                    ...resource,
                    // Map real optimization data to display format
                    optimization_status: optimizationStatus,
                    potential_monthly_savings: {
                        amount: Math.round(estimatedSavings * 100) / 100, // Round to 2 decimal places
                        currency: resource.currency || 'USD'
                    },
                    optimization_source: getOptimizationSource(resource),
                    optimization_last_updated: resource.compute_optimizer_last_refresh ||
                        resource.lastFetched ||
                        new Date().toISOString(),
                    optimization_confidence: getOptimizationConfidence(resource)
                };
            });

            setResources(transformedResources);

            // Generate recommendations from resources that need optimization
            // Requirements 6.2, 6.3, 6.4: Include Over-Provisioned and Under-Provisioned, exclude Optimal
            const recs = transformedResources
                .filter(r => {
                    const status = r.optimization_status;
                    // Include only Over-Provisioned and Under-Provisioned resources with savings > 0
                    return (status === 'Over-Provisioned' || status === 'Under-Provisioned') &&
                        r.potential_monthly_savings?.amount > 0;
                })
                .map(r => ({
                    id: r.resourceId,
                    name: r.name,
                    region: r.region,
                    finding: r.optimization_status,
                    savings: r.potential_monthly_savings?.amount || 0,
                    source: r.optimization_source
                }))
                // Requirement 6.1: Rank by potential savings in descending order
                .sort((a, b) => b.savings - a.savings);

            setRecommendations(recs);

            // Set optimization metadata
            const lastUpdated = transformedResources
                .map(r => r.optimization_last_updated)
                .filter(Boolean)
                .sort((a, b) => new Date(b) - new Date(a))[0];

            setOptimizationLastUpdated(lastUpdated);
            setOptimizationError(null);
        } catch (e) {
            console.error('[Dashboard] Failed to load from localStorage:', e);
            setOptimizationError('Failed to load optimization data');
        } finally {
            setLoading(false);
        }
    };

    // Helper function to map backend optimization data to display format
    const mapOptimizationStatus = (resource) => {
        // Priority: Use real cloud provider optimization data first

        // AWS Compute Optimizer data
        if (resource.compute_optimizer_finding) {
            switch (resource.compute_optimizer_finding.toLowerCase()) {
                case 'overprovisioned':
                case 'over_provisioned':
                    return 'Over-Provisioned';
                case 'underprovisioned':
                case 'under_provisioned':
                    return 'Under-Provisioned';
                case 'optimized':
                    return 'Optimal';
                case 'notavailable':
                case 'not_available':
                    return 'No-Recommendation';
                default:
                    return 'No-Recommendation';
            }
        }

        // Azure Advisor data (check for Azure-specific fields)
        if (resource.provider === 'Azure' && resource.optimizationStatus) {
            switch (resource.optimizationStatus.toLowerCase()) {
                case 'oversized':
                case 'overprovisioned':
                    return 'Over-Provisioned';
                case 'undersized':
                case 'underprovisioned':
                    return 'Under-Provisioned';
                case 'optimal':
                case 'optimized':
                    return 'Optimal';
                default:
                    return 'No-Recommendation';
            }
        }

        // GCP Recommender data (check for GCP-specific fields)
        if (resource.provider === 'GCP' && resource.gcp_recommender_type) {
            // GCP recommendations indicate optimization opportunities
            if (resource.gcp_recommender_type === 'google.compute.instance.MachineTypeRecommender') {
                return 'Over-Provisioned'; // Machine type recommender suggests downsizing
            }
            if (resource.gcp_recommender_type === 'google.compute.instance.IdleResourceRecommender') {
                return 'Under-Provisioned'; // Idle resource recommender suggests the resource is underutilized
            }
            return 'Optimal';
        }

        // Fallback: Check generic optimizationStatus field
        if (resource.optimizationStatus) {
            switch (resource.optimizationStatus.toLowerCase()) {
                case 'overprovisioned':
                case 'oversized':
                case 'over-provisioned':
                    return 'Over-Provisioned';
                case 'underprovisioned':
                case 'undersized':
                case 'under-provisioned':
                    return 'Under-Provisioned';
                case 'optimized':
                case 'optimal':
                    return 'Optimal';
                default:
                    return 'No-Recommendation';
            }
        }

        // If no optimization data available from any cloud provider
        return 'No-Recommendation';
    };

    // Helper function to determine optimization source
    const getOptimizationSource = (resource) => {
        // AWS Compute Optimizer
        if (resource.compute_optimizer_finding) {
            return 'AWS Compute Optimizer';
        }

        // Azure Advisor
        if (resource.provider === 'Azure' && resource.optimizationStatus) {
            return 'Azure Advisor';
        }

        // GCP Recommender
        if (resource.provider === 'GCP' && resource.gcp_recommender_type) {
            return 'GCP Recommender';
        }

        // Generic cloud provider optimization data
        if (resource.optimizationStatus) {
            switch (resource.provider) {
                case 'AWS': return 'AWS Compute Optimizer';
                case 'Azure': return 'Azure Advisor';
                case 'GCP': return 'GCP Recommender';
                default: return 'Cloud Provider';
            }
        }

        return null;
    };

    // Helper function to get optimization confidence
    const getOptimizationConfidence = (resource) => {
        // Use existing confidence or derive from performance risk
        if (resource.confidence) return resource.confidence;

        const options = resource.compute_optimizer_recommendation_options;
        if (options && options.length > 0) {
            const risk = options[0].performance_risk;
            if (risk <= 1) return 'High';
            if (risk <= 3) return 'Medium';
            return 'Low';
        }

        return null;
    };

    const fetchResources = async (shouldSync = false) => {
        setLoading(true);
        setOptimizationError(null);

        if (shouldSync) {
            setOptimizationLoading(true);
            setSyncProgress({ elapsed: 0, status: 'Initializing...' });

            // Start timer
            const startTime = Date.now();
            const progressInterval = setInterval(() => {
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                const status = elapsed < 10 ? 'Connecting to cloud...' :
                    elapsed < 20 ? 'Fetching instances...' :
                        elapsed < 40 ? 'Collecting optimization data...' :
                            elapsed < 60 ? 'Processing recommendations...' :
                                'Almost done...';
                setSyncProgress({ elapsed, status });
            }, 1000);

            try {
                console.log('[Dashboard] Calling /api/cloud/fetch...');
                const syncRes = await api.post('/cloud/fetch', { userId });

                clearInterval(progressInterval);

                if (syncRes.data.success) {
                    const resources = syncRes.data.resources || [];
                    console.log('[Dashboard] Fetched', resources.length, 'resources from cloud');

                    setSyncProgress({
                        elapsed: Math.floor((Date.now() - startTime) / 1000),
                        status: `Processing ${resources.length} resources...`
                    });

                    // Save to localStorage
                    localStorageService.saveResources(resources);

                    // Reload from localStorage (this will transform the data)
                    loadResourcesFromLocalStorage();

                    setOptimizationLastUpdated(new Date().toISOString());
                } else {
                    console.error('[Dashboard] Sync failed:', syncRes.data.error);
                    setOptimizationError(syncRes.data.error || 'Failed to fetch optimization data');

                    // Check if error is credential-related
                    if (syncRes.data.error?.includes('credentials') || syncRes.data.error?.includes('invalid')) {
                        await checkCloudConfigs();
                    }
                }
            } catch (e) {
                clearInterval(progressInterval);
                console.error('Failed to fetch dashboard data:', e);

                const errorMessage = e.response?.data?.error || e.message || 'Failed to fetch optimization data';
                setOptimizationError(errorMessage);

                // Check if error is credential-related
                if (errorMessage.includes('credentials') || errorMessage.includes('invalid')) {
                    await checkCloudConfigs();
                }
            } finally {
                setSyncProgress({ elapsed: 0, status: '' });
                setOptimizationLoading(false);
            }
        } else {
            // Just reload from localStorage
            loadResourcesFromLocalStorage();
        }

        setLoading(false);
    };

    const handleDisconnect = async () => {
        if (!confirm('Are you sure you want to disconnect? This will remove all synced data.')) return;
        try {
            await api.delete('/cloud/config', { data: { userId, provider: 'AWS' } });
            await api.delete('/cloud/config', { data: { userId, provider: 'Azure' } });
            await api.delete('/cloud/config', { data: { userId, provider: 'GCP' } });

            // Clear localStorage
            localStorageService.clearResources();

            navigate('/cloud/connect');
        } catch { alert('Failed to disconnect. Please try again.'); }
    };

    const instances = resources.filter(r => r.service === 'EC2' || r.service === 'Virtual Machine' || r.service === 'Compute Engine');
    const totalSavings = resources.reduce((acc, r) => acc + (r.potential_monthly_savings?.amount || 0), 0);

    // Get all unique connected providers
    const connectedProviders = [...new Set(resources.map(r => r.provider))].filter(Boolean);
    const connectedProviderText = connectedProviders.length > 0
        ? connectedProviders.length === 1
            ? `${connectedProviders[0]} Connected`
            : `${connectedProviders.length} Clouds Connected`
        : 'No Cloud Connected';

    // Calculate instance status by cloud provider
    const cloudStats = connectedProviders.map(provider => {
        const providerInstances = instances.filter(i => i.provider === provider);
        const running = providerInstances.filter(i => {
            const state = i.state?.toLowerCase() || i.status?.toLowerCase() || '';
            return state === 'running' || state === 'active';
        }).length;
        const stopped = providerInstances.filter(i => {
            const state = i.state?.toLowerCase() || i.status?.toLowerCase() || '';
            return state === 'stopped' || state === 'deallocated' || state === 'terminated';
        }).length;
        const total = providerInstances.length;

        return {
            provider,
            total,
            running,
            stopped,
            other: total - running - stopped
        };
    });

    const tableData = instances;

    // Check if we're currently syncing (recently connected and have few/no resources)
    const isSyncing = connectedProviders.length > 0 && resources.length < 5;
    const [autoRefresh, setAutoRefresh] = useState(false); // Disabled by default for localStorage

    // Note: Auto-refresh disabled for localStorage mode
    // Users must manually click "Sync Resources" to fetch fresh data

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* Syncing Banner */}
            {(isSyncing || syncProgress.elapsed > 0) && (
                <div style={{ background: 'var(--az-blue-light)', border: '1px solid var(--az-blue)', borderRadius: 6, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
                    <RefreshCw size={16} style={{ color: 'var(--az-blue)', animation: 'spin 2s linear infinite' }} />
                    <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--az-blue)', marginBottom: 2 }}>
                            {syncProgress.status || 'Syncing resources and optimization data...'}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--az-text-2)' }}>
                            {syncProgress.elapsed > 0 ? (
                                <>
                                    Time elapsed: <span style={{ fontWeight: 600 }}>{syncProgress.elapsed}s</span>
                                    {syncProgress.elapsed < 60 && <span> / Estimated: 30-60s</span>}
                                    {syncProgress.elapsed > 60 && <span style={{ color: 'var(--az-warning)' }}> - Taking longer than expected</span>}
                                </>
                            ) : (
                                'Fetching cloud resources and optimization recommendations from all providers.'
                            )}
                        </div>
                        {syncProgress.elapsed > 0 && (
                            <div style={{
                                width: '100%',
                                height: 4,
                                background: '#E1DFDD',
                                borderRadius: 2,
                                overflow: 'hidden',
                                marginTop: 8
                            }}>
                                <div style={{
                                    height: '100%',
                                    width: `${Math.min(100, (syncProgress.elapsed / 60) * 100)}%`,
                                    background: 'var(--az-blue)',
                                    transition: 'width 1s linear',
                                    borderRadius: 2
                                }} />
                            </div>
                        )}
                    </div>
                    <button
                        onClick={() => setAutoRefresh(!autoRefresh)}
                        style={{
                            background: autoRefresh ? 'var(--az-blue)' : '#fff',
                            color: autoRefresh ? '#fff' : 'var(--az-blue)',
                            border: `1px solid var(--az-blue)`,
                            borderRadius: 4,
                            padding: '6px 12px',
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: 'pointer'
                        }}
                    >
                        {autoRefresh ? 'Auto-refreshing' : 'Paused'}
                    </button>
                </div>
            )}
            {/* Header row */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
                <div>
                    <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: 'var(--az-text)' }}>Cloud Overview</h1>
                    <p style={{ margin: '4px 0 0 0', fontSize: 13, color: 'var(--az-text-2)' }}>
                        Real-time usage and optimization insights
                    </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid var(--az-border)', borderRadius: 4, padding: '5px 12px', fontSize: 12 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--az-success)', display: 'inline-block' }} />
                        <span style={{ fontWeight: 600, color: 'var(--az-text)' }}>{connectedProviderText}</span>
                        <span style={{ color: 'var(--az-text-3)' }}>· Auto-sync active</span>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => fetchResources(true)} disabled={loading} title="Refresh">
                        <RefreshCw size={14} className={loading ? 'az-spin' : ''} />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={handleDisconnect} className="az-btn-danger" title="Disconnect">
                        <Trash2 size={14} />
                    </Button>
                </div>
            </div>

            {/* Invalid Credentials Warning */}
            {invalidCredentials.length > 0 && invalidCredentials.map(config => (
                <CloudAccessWarning
                    key={config.provider}
                    provider={config.provider}
                    message={config.lastError}
                    onReconnect={() => navigate('/cloud/connect')}
                />
            ))}

            {/* Stat cards */}
            <AnimatedContainer staggerDelay={0.2}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                    <AnimatedItem>
                        <StatCard icon={Server} iconBg='#EFF6FF' iconColor='var(--az-blue)' label="Active Instances" value={instances.length} sub={`${instances.filter(i => i.optimization_status === 'Optimal').length} optimized`} badge="Auto-Synced" />
                    </AnimatedItem>
                    <AnimatedItem>
                        <div style={{ ...AZ.stat.wrapper, background: 'var(--az-blue)', borderColor: 'var(--az-blue)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                                <TrendingDown size={16} style={{ color: 'rgba(255,255,255,0.8)' }} />
                                <span style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.8)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Potential Savings</span>
                            </div>
                            <div style={{ fontSize: 30, fontWeight: 700, color: '#fff', lineHeight: 1 }}>${totalSavings.toFixed(0)}<span style={{ fontSize: 16, fontWeight: 400 }}>/mo</span></div>
                            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', margin: '4px 0 8px 0' }}>Based on current utilization</p>
                            <button
                                onClick={() => navigate('/cloud/instances')}
                                style={{ background: 'rgba(255,255,255,0.15)', color: '#fff', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 4, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                            >
                                View Details →
                            </button>
                        </div>
                    </AnimatedItem>
                </div>
            </AnimatedContainer>

            {/* Cloud-specific instance status cards */}
            {cloudStats.length > 0 && (
                <AnimatedSection>
                    <div style={{ background: '#fff', border: '1px solid var(--az-border)', borderRadius: 6, padding: '16px 20px' }}>
                        <h3 style={{ margin: '0 0 16px 0', fontSize: 14, fontWeight: 600, color: 'var(--az-text)' }}>Instance Status by Cloud Provider</h3>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
                            {cloudStats.map(stat => {
                                const providerColors = {
                                    AWS: { bg: '#FFF4E5', color: '#FF9900', border: '#FF9900' },
                                    Azure: { bg: '#E6F4FF', color: '#0089D6', border: '#0089D6' },
                                    GCP: { bg: '#F0FDF4', color: '#34A853', border: '#34A853' }
                                };
                                const colors = providerColors[stat.provider] || { bg: '#F3F2F1', color: 'var(--az-text)', border: 'var(--az-border)' };

                                return (
                                    <div key={stat.provider} style={{ background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 6, padding: '12px 16px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                                            <div style={{ fontSize: 13, fontWeight: 700, color: colors.color }}>{stat.provider}</div>
                                            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--az-text-2)' }}>({stat.total} total)</div>
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--az-success)' }} />
                                                    <span style={{ fontSize: 12, color: 'var(--az-text-2)' }}>Running</span>
                                                </div>
                                                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--az-text)' }}>{stat.running}</span>
                                            </div>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--az-error)' }} />
                                                    <span style={{ fontSize: 12, color: 'var(--az-text-2)' }}>Stopped</span>
                                                </div>
                                                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--az-text)' }}>{stat.stopped}</span>
                                            </div>
                                            {stat.other > 0 && (
                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--az-text-3)' }} />
                                                        <span style={{ fontSize: 12, color: 'var(--az-text-2)' }}>Other</span>
                                                    </div>
                                                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--az-text)' }}>{stat.other}</span>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </AnimatedSection>
            )}

            {/* Content grid */}
            <AnimatedSection>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 16 }}>
                    {/* Resource table */}
                    <div style={{ background: '#fff', border: '1px solid var(--az-border)', borderRadius: 6, overflow: 'hidden' }}>
                        <div style={{ overflowX: 'auto' }}>
                            <table className="az-table">
                                <thead>
                                    <tr>
                                        <th>Name / ID</th>
                                        <th>Provider</th>
                                        <th>Type</th>
                                        <th>Region</th>
                                        <th>Status</th>
                                        <th>Optimization</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {loading ? (
                                        <tr><td colSpan={6} style={{ textAlign: 'center', padding: 32, color: 'var(--az-text-2)' }}>Loading...</td></tr>
                                    ) : tableData.length === 0 ? (
                                        <tr><td colSpan={6} style={{ textAlign: 'center', padding: '40px', color: 'var(--az-text-2)' }}>
                                            No resources found. Connect your cloud account to sync.
                                        </td></tr>
                                    ) : tableData.map(res => (
                                        <tr key={res.resourceId} onClick={() => navigate(`/cloud/resource/${res._id}`, { state: { resource: res } })} style={{ cursor: 'pointer' }}>
                                            <td>
                                                <div style={{ fontWeight: 500, color: 'var(--az-blue)', fontSize: 13 }}>{res.name}</div>
                                                <div style={{ fontSize: 11, color: 'var(--az-text-3)', fontFamily: 'monospace' }}>{res.resourceId}</div>
                                            </td>
                                            <td><ProviderBadge p={res.provider} /></td>
                                            <td style={{ fontSize: 13, fontFamily: 'monospace' }}>{res.resourceType}</td>
                                            <td style={{ fontSize: 12, color: 'var(--az-text-2)' }}>{res.region}</td>
                                            <td><Badge variant="success">Active</Badge></td>
                                            <td>
                                                <OptBadge
                                                    s={res.optimization_status}
                                                    source={res.optimization_source}
                                                    error={optimizationError}
                                                />
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* Recommendations panel */}
                    <div style={{ background: '#fff', border: '1px solid var(--az-border)', borderRadius: 6, overflow: 'hidden' }}>
                        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--az-border)', background: 'var(--az-surface)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--az-text)' }}>Optimization Highlights</span>
                            {optimizationLoading && (
                                <RefreshCw size={12} style={{ color: 'var(--az-blue)', animation: 'spin 2s linear infinite' }} />
                            )}
                            {optimizationLastUpdated && !optimizationLoading && (
                                <span style={{ fontSize: 11, color: 'var(--az-text-3)' }}>
                                    Updated {new Date(optimizationLastUpdated).toLocaleTimeString()}
                                </span>
                            )}
                        </div>
                        <div style={{ padding: '8px 0' }}>
                            {optimizationError ? (
                                <div style={{ textAlign: 'center', padding: '20px 16px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 8 }}>
                                        <AlertTriangle size={16} style={{ color: 'var(--az-warning)' }} />
                                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--az-text)' }}>Optimization Data Unavailable</span>
                                    </div>
                                    <p style={{ fontSize: 12, color: 'var(--az-text-2)', margin: '0 0 12px 0' }}>
                                        {optimizationError}
                                    </p>
                                    <button
                                        onClick={() => fetchResources(true)}
                                        style={{
                                            fontSize: 12,
                                            fontWeight: 600,
                                            color: 'var(--az-blue)',
                                            background: 'none',
                                            border: '1px solid var(--az-blue)',
                                            borderRadius: 4,
                                            padding: '6px 12px',
                                            cursor: 'pointer'
                                        }}
                                    >
                                        Retry
                                    </button>
                                </div>
                            ) : recommendations.length > 0 ? recommendations.slice(0, 6).map((rec, i) => {
                                // Find the full resource object to get _id
                                const fullResource = resources.find(r => r.resourceId === rec.id);
                                return (
                                    <div
                                        key={i}
                                        onClick={() => fullResource && navigate(`/cloud/resource/${fullResource._id}`, { state: { resource: fullResource } })}
                                        style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 16px', cursor: 'pointer', transition: 'background 0.12s' }}
                                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--az-bg)')}
                                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                                    >
                                        <AlertTriangle size={14} style={{ color: 'var(--az-warning)', marginTop: 2, flexShrink: 0 }} />
                                        <div style={{ overflow: 'hidden' }}>
                                            <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: 'var(--az-blue)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {rec.finding || 'Optimization Opportunity'}
                                            </p>
                                            <p style={{ margin: '2px 0 0 0', fontSize: 11, color: 'var(--az-text-2)' }}>
                                                {rec.name} · {rec.region}
                                                {rec.source && <span style={{ color: 'var(--az-text-3)' }}> · {rec.source}</span>}
                                            </p>
                                            <p style={{ margin: '2px 0 0 0', fontSize: 11, fontWeight: 600, color: 'var(--az-success)' }}>
                                                Save ${rec.savings > 0 ? rec.savings.toFixed(0) : '0'}/mo
                                            </p>
                                        </div>
                                    </div>
                                );
                            }) : (
                                <div style={{ textAlign: 'center', padding: '20px 16px', fontSize: 13, color: 'var(--az-text-2)' }}>
                                    {optimizationLoading ? 'Loading optimization data...' : 'No optimization opportunities found.'}
                                </div>
                            )}
                        </div>
                        {recommendations.length > 0 && !optimizationError && (
                            <div style={{ padding: '10px 16px', borderTop: '1px solid var(--az-border)' }}>
                                <button
                                    onClick={() => navigate('/cloud/instances')}
                                    style={{ fontSize: 12, fontWeight: 600, color: 'var(--az-blue)', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                                >
                                    View All <ArrowUpRight size={12} />
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </AnimatedSection>
        </div>
    );
}

function ProviderBadge({ p }) {
    const map = { AWS: { bg: '#FFF4E5', color: '#D47A00' }, Azure: { bg: 'var(--az-blue-light)', color: 'var(--az-blue)' }, GCP: { bg: '#F0FDF4', color: 'var(--az-success)' } };
    const s = map[p] || { bg: '#F3F2F1', color: 'var(--az-text-2)' };
    return <span style={{ background: s.bg, color: s.color, padding: '2px 8px', borderRadius: 3, fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>{p}</span>;
}

function OptBadge({ s, source, error }) {
    // Handle error state
    if (error) {
        return (
            <Badge variant="neutral" title={`Error: ${error}`}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <AlertTriangle size={10} />
                    Error
                </span>
            </Badge>
        );
    }

    // Handle different optimization statuses with proper color coding
    if (s === 'Over-Provisioned') {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Badge variant="warning" title={source ? `Source: ${source}` : undefined}>
                    Over-Provisioned
                </Badge>
                {source && (
                    <div style={{ fontSize: 10, color: 'var(--az-text-3)', textAlign: 'center' }}>
                        {source}
                    </div>
                )}
            </div>
        );
    }
    if (s === 'Under-Provisioned') {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Badge variant="neutral" title={source ? `Source: ${source}` : undefined}>
                    Under-Provisioned
                </Badge>
                {source && (
                    <div style={{ fontSize: 10, color: 'var(--az-text-3)', textAlign: 'center' }}>
                        {source}
                    </div>
                )}
            </div>
        );
    }
    if (s === 'Optimal') {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Badge variant="success" title={source ? `Source: ${source}` : undefined}>
                    Optimal
                </Badge>
                {source && (
                    <div style={{ fontSize: 10, color: 'var(--az-text-3)', textAlign: 'center' }}>
                        {source}
                    </div>
                )}
            </div>
        );
    }

    // Default case for no recommendation or unknown status
    return (
        <Badge variant="neutral" title="No optimization data available">
            —
        </Badge>
    );
}
