import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Server, RefreshCw, Search, TrendingDown, AlertTriangle, Clock, FileText } from 'lucide-react';
import api from '../../services/api';
import * as localStorageService from '../../services/localStorageService';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Loader from '../../components/common/Loader';
import PredictionBadge from '../../components/common/PredictionBadge';
import ConfidenceIndicator from '../../components/common/ConfidenceIndicator';
import Toast from '../../components/common/Toast';
import { FadeIn, AnimatedSection, AnimatedContainer, AnimatedItem } from '../../components/animations/AnimatedSection';
import { generatePDFReport } from '../../utils/pdfReportGenerator';

// Format timestamp for display
function formatTimestamp(timestamp) {
    if (!timestamp) return 'N/A';
    try {
        const date = new Date(timestamp);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;

        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) {
        return 'N/A';
    }
}

function StatCard({ icon: Icon, iconBg, iconColor, label, value, sub, onClick }) {
    return (
        <div
            style={{
                background: '#fff',
                border: '1px solid var(--az-border)',
                borderRadius: 6,
                padding: '16px 20px',
                cursor: onClick ? 'pointer' : 'default',
                transition: 'all 0.2s ease'
            }}
            onClick={onClick}
            onMouseEnter={(e) => {
                if (onClick) {
                    e.currentTarget.style.borderColor = 'var(--az-blue)';
                    e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)';
                    e.currentTarget.style.transform = 'translateY(-2px)';
                }
            }}
            onMouseLeave={(e) => {
                if (onClick) {
                    e.currentTarget.style.borderColor = 'var(--az-border)';
                    e.currentTarget.style.boxShadow = 'none';
                    e.currentTarget.style.transform = 'translateY(0)';
                }
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <div style={{ width: 34, height: 34, borderRadius: 6, background: iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon size={17} style={{ color: iconColor }} />
                </div>
                <span style={{ fontSize: 12, color: 'var(--az-text-2)', fontWeight: 500 }}>{label}</span>
            </div>
            <div style={{ fontSize: 26, fontWeight: 700, color: iconColor, lineHeight: 1 }}>{value}</div>
            {sub && <div style={{ fontSize: 12, color: 'var(--az-text-3)', marginTop: 4 }}>{sub}</div>}
        </div>
    );
}

function OptBadge({ s }) {
    const statusUpper = (s || '').toUpperCase();

    // Compute Optimizer findings
    if (statusUpper === 'OPTIMIZED') {
        return <Badge variant="success">Optimized</Badge>;
    }
    if (statusUpper === 'OVERPROVISIONED') {
        return <Badge variant="warning">Over-Provisioned</Badge>;
    }
    if (statusUpper === 'UNDERPROVISIONED') {
        return <Badge variant="error">Under-Provisioned</Badge>;
    }
    if (statusUpper === 'NOTAVAILABLE') {
        return <Badge variant="neutral">Insufficient Data</Badge>;
    }

    // ML-based recommendations (backward compatibility)
    if (statusUpper === 'OPTIMAL') {
        return <Badge variant="success">Optimal</Badge>;
    }
    if (statusUpper === 'OVERSIZED' || statusUpper === 'OVERUTILIZED') {
        return <Badge variant="danger">Oversized</Badge>;
    }
    if (statusUpper === 'UNDERSIZED' || statusUpper === 'UNDERUTILIZED') {
        return <Badge variant="warning">Undersized</Badge>;
    }
    if (statusUpper === 'INSUFFICIENT_DATA') {
        return <Badge variant="neutral">Insufficient Data</Badge>;
    }
    return <Badge variant="neutral">Unknown</Badge>;
}

function StatusBadge({ status }) {
    const statusLower = (status || 'unknown').toLowerCase();

    // Running states
    if (statusLower === 'running' || statusLower === 'active') {
        return (
            <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                background: 'var(--az-success-bg)', color: 'var(--az-success)'
            }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--az-success)' }} />
                Running
            </span>
        );
    }

    // Stopped states
    if (statusLower === 'stopped' || statusLower === 'deallocated') {
        return (
            <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                background: 'var(--az-warning-bg)', color: '#8A3707'
            }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#8A3707' }} />
                Stopped
            </span>
        );
    }

    // Terminated/Deleted states
    if (statusLower === 'terminated' || statusLower === 'deleted') {
        return (
            <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                background: 'var(--az-error-bg)', color: 'var(--az-error)'
            }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--az-error)' }} />
                Terminated
            </span>
        );
    }

    // Pending/Starting states
    if (statusLower === 'pending' || statusLower === 'starting') {
        return (
            <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                background: 'var(--az-info-bg)', color: 'var(--az-info)'
            }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--az-info)' }} />
                Starting
            </span>
        );
    }

    // Stopping states
    if (statusLower === 'stopping') {
        return (
            <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                background: 'var(--az-warning-bg)', color: '#8A3707'
            }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#8A3707' }} />
                Stopping
            </span>
        );
    }

    // Unknown/Other states
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600,
            background: '#F3F2F1', color: 'var(--az-text-2)'
        }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--az-text-3)' }} />
            {status || 'Unknown'}
        </span>
    );
}

function MetricsStatusBadge({ metricsStatus, memoryMetricsSource }) {
    // Metrics status badge
    if (metricsStatus === 'instance_stopped') {
        return (
            <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                background: '#F3F2F1', color: 'var(--az-text-3)'
            }} title="Instance stopped - no metrics available">
                Stopped
            </span>
        );
    }

    if (metricsStatus === 'insufficient_data') {
        return (
            <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                background: 'var(--az-warning-bg)', color: 'var(--az-warning)'
            }} title="Insufficient uptime for reliable metrics">
                <AlertTriangle size={10} />
                Low Data
            </span>
        );
    }

    if (metricsStatus === 'complete') {
        return (
            <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                background: 'var(--az-success-bg)', color: 'var(--az-success)'
            }} title="All metrics available">
                Complete
            </span>
        );
    }

    if (metricsStatus === 'partial' || memoryMetricsSource === 'agent_required') {
        return (
            <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                background: 'var(--az-blue-light)', color: 'var(--az-blue)'
            }} title="CPU available, memory requires agent">
                Partial
            </span>
        );
    }

    if (metricsStatus === 'missing') {
        return (
            <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 600,
                background: 'var(--az-error-bg)', color: 'var(--az-error)'
            }} title="Metrics unavailable">
                Missing
            </span>
        );
    }

    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 600,
            background: '#F3F2F1', color: 'var(--az-text-3)'
        }}>
            N/A
        </span>
    );
}

function ProviderBadge({ p }) {
    const m = { AWS: '#FFF4E5,#D47A00', Azure: 'var(--az-blue-light),var(--az-blue)', GCP: '#F0FDF4,var(--az-success)' };
    const [bg, color] = (m[p] || '#F3F2F1,var(--az-text-2)').split(',');
    return <span style={{ background: bg, color, padding: '2px 8px', borderRadius: 3, fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>{p}</span>;
}


export default function Instances() {
    const [instances, setInstances] = useState([]);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [autoFetching, setAutoFetching] = useState(false);
    const [syncProgress, setSyncProgress] = useState({ elapsed: 0, status: '' });
    const [search, setSearch] = useState('');
    const [filterStatus, setFilterStatus] = useState('all');
    const [filterOpt, setFilterOpt] = useState('all');
    const [hasCloudConnection, setHasCloudConnection] = useState(false);
    const [showReportModal, setShowReportModal] = useState(false);
    const [reportName, setReportName] = useState('');
    const [savingReport, setSavingReport] = useState(false);
    const [toastState, setToastState] = useState(null);
    const navigate = useNavigate();
    const userId = localStorage.getItem('userId');

    const showToast = (message, type = 'success') => setToastState({ message, type });

    useEffect(() => {
        const initializePage = async () => {
            // SECURITY: Migrate old shared data to user-specific storage
            localStorageService.migrateToUserSpecificStorage();

            // First, check cloud connection
            const hasConnection = await checkCloudConnection();

            // Then load from localStorage
            loadInstancesFromLocalStorage();

            // Check if we need to auto-fetch
            const existingData = localStorageService.getResources();
            const needsRefresh = localStorageService.needsRefresh(5); // 5 minutes threshold

            // Auto-fetch immediately if cloud is connected and (no data OR stale data)
            if (hasConnection && (existingData.length === 0 || needsRefresh)) {
                console.log('[Instances] Auto-fetching resources immediately...', {
                    noData: existingData.length === 0,
                    stale: needsRefresh
                });
                setAutoFetching(true);
                handleSyncResources(); // No delay - fetch immediately
            }
        };

        initializePage();
    }, []);

    const checkCloudConnection = async () => {
        try {
            const res = await api.get(`/cloud/config/${userId}`);
            console.log('[Instances] Cloud configs:', res.data);
            const hasConnection = res.data && res.data.length > 0;
            setHasCloudConnection(hasConnection);
            return hasConnection;
        } catch (err) {
            console.error('[Instances] Failed to check cloud connection:', err);
            setHasCloudConnection(false);
            return false;
        }
    };

    const loadInstancesFromLocalStorage = () => {
        setLoading(true);
        try {
            const allResources = localStorageService.getResources();
            console.log('[Instances] Loaded from localStorage:', allResources.length, 'resources');

            // Filter by service field (same as Dashboard)
            const filtered = allResources.filter(r =>
                r.service === 'EC2' || r.service === 'Virtual Machine' || r.service === 'Compute Engine'
            );
            console.log('[Instances] Filtered instances:', filtered.length);
            console.log('[Instances] Sample instance data:', filtered[0]); // Debug: see what fields are available
            setInstances(filtered);
        } catch (err) {
            console.error('[Instances] Failed to load from localStorage:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleSyncResources = async () => {
        setSyncing(true);
        setAutoFetching(false); // Clear auto-fetching flag
        setSyncProgress({ elapsed: 0, status: 'Initializing...' });

        // Start timer
        const startTime = Date.now();
        const progressInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            const status = elapsed < 15 ? 'Connecting to cloud...' :
                elapsed < 30 ? 'Fetching instances...' :
                    elapsed < 60 ? 'Collecting metrics...' :
                        elapsed < 90 ? 'Running ML predictions...' :
                            'Finalizing...';
            setSyncProgress({ elapsed, status });
        }, 1000);

        try {
            console.log('[Instances] Calling /api/cloud/fetch...');
            const res = await api.post('/cloud/fetch', { userId });

            clearInterval(progressInterval);

            if (res.data.success) {
                const resources = res.data.resources || [];
                console.log('[Instances] Fetched', resources.length, 'resources from cloud');

                setSyncProgress({
                    elapsed: Math.floor((Date.now() - startTime) / 1000),
                    status: `Saving ${resources.length} resources...`
                });

                // Save to localStorage
                localStorageService.saveResources(resources);

                // Reload from localStorage
                loadInstancesFromLocalStorage();

                console.log('[Instances] Sync complete');
            } else {
                console.error('[Instances] Sync failed:', res.data.error);
                alert('Failed to sync resources: ' + (res.data.error || 'Unknown error'));
            }
        } catch (err) {
            clearInterval(progressInterval);
            console.error('[Instances] Sync error:', err);
            console.error('[Instances] Error details:', {
                message: err.message,
                response: err.response?.data,
                status: err.response?.status
            });

            // Show more detailed error message
            const errorMessage = err.response?.data?.error || err.message || 'Unknown error';
            alert(`Failed to sync resources: ${errorMessage}\n\nPlease check:\n1. Backend is running on port 3001\n2. You are logged in\n3. Cloud credentials are configured`);
        } finally {
            setSyncing(false);
            setSyncProgress({ elapsed: 0, status: '' });
        }
    };

    const handleNeedsAttentionClick = () => {
        // Toggle between showing all instances and only those needing attention
        if (filterOpt === 'needs_attention') {
            setFilterOpt('all');
        } else {
            setFilterOpt('needs_attention');
        }
    };

    const generateReport = () => {
        setShowReportModal(true);
    };

    const handleSaveReport = async () => {
        if (!reportName.trim()) {
            showToast('Please enter a report name', 'error');
            return;
        }

        setSavingReport(true);
        setShowReportModal(false);

        try {
            // Transform instance data to match Report model schema
            const formattedRecommendations = instances.map(instance => {
                // Normalize finding to match backend expectations (Oversized, Undersized, Optimal)
                let finding = 'Unknown';
                const rawFinding = instance.compute_optimizer_finding || instance.recommendation || instance.optimizationStatus || '';
                const findingUpper = rawFinding.toUpperCase();

                // Map AWS Compute Optimizer findings
                if (findingUpper === 'OVERPROVISIONED' || findingUpper === 'OVERSIZED' || findingUpper === 'OVERUTILIZED') {
                    finding = 'Oversized';
                } else if (findingUpper === 'UNDERPROVISIONED' || findingUpper === 'UNDERSIZED' || findingUpper === 'UNDERUTILIZED') {
                    finding = 'Undersized';
                } else if (findingUpper === 'OPTIMIZED' || findingUpper === 'OPTIMAL') {
                    finding = 'Optimal';
                }

                return {
                    id: instance._id || instance.id,
                    name: instance.name,
                    cloud: (instance.provider || '').toLowerCase(),
                    resourceType: instance.resourceType,
                    finding: finding,
                    instanceType: instance.resourceType, // current type
                    recommendedType: instance.recommended_instance_type || instance.resourceType,
                    cpuUsage: instance.cpu_avg != null ? instance.cpu_avg : (instance.avgCpuUtilization || 0),
                    memUsage: instance.memory_avg != null ? instance.memory_avg : (instance.avgMemoryUtilization || 0),
                    savings: instance.potential_monthly_savings || 0,
                    confidence: instance.confidence || 0,
                    region: instance.region,
                    recommendation: instance.recommendation || 'No recommendation available'
                };
            });

            // Call API to save report
            await api.post('/reports/generate', {
                name: reportName.trim(),
                type: 'Cloud',
                recommendations: formattedRecommendations
            });

            // Generate PDF after successful save
            generatePDFReport(instances, formatTimestamp);

            setReportName('');
            showToast('Report saved! View it in the Reports page.', 'success');
        } catch (err) {
            if (err.response?.status === 401) {
                showToast('Session expired. Please log in again.', 'error');
                setTimeout(() => navigate('/auth/login'), 2000);
            } else {
                showToast('Failed to save report.', 'error');
            }
        } finally {
            setSavingReport(false);
        }
    };

    const handleCancelModal = () => {
        setShowReportModal(false);
        setReportName('');
    };

    const filtered = instances.filter(i => {
        const ms = !search || i.name?.toLowerCase().includes(search.toLowerCase()) || i.resourceId?.toLowerCase().includes(search.toLowerCase()) || i.region?.toLowerCase().includes(search.toLowerCase());
        const mst = filterStatus === 'all' || (i.status || '').toLowerCase() === filterStatus;

        // Handle optimization filter
        let mo = true;
        if (filterOpt === 'needs_attention') {
            // Show instances that need attention (over-provisioned or under-provisioned)
            const providerLower = (i.provider || '').toLowerCase();
            if (providerLower === 'aws' && i.compute_optimizer_finding) {
                mo = ['Overprovisioned', 'Underprovisioned'].includes(i.compute_optimizer_finding);
            } else {
                mo = ['OVERSIZED', 'UNDERSIZED', 'OVERUTILIZED', 'UNDERUTILIZED'].includes((i.optimizationStatus || '').toUpperCase());
            }
        } else if (filterOpt !== 'all') {
            // Handle both Compute Optimizer findings and ML-based optimization status
            const providerLower = (i.provider || '').toLowerCase();
            if (providerLower === 'aws' && i.compute_optimizer_finding) {
                // For AWS instances with Compute Optimizer data
                mo = i.compute_optimizer_finding === filterOpt;
            } else {
                // For other instances with ML-based recommendations
                // Map new filter values to old ML values
                const mlValueMap = {
                    'Optimized': 'OPTIMAL',
                    'Overprovisioned': 'OVERSIZED',
                    'Underprovisioned': 'UNDERSIZED'
                };
                const mlValue = mlValueMap[filterOpt] || filterOpt;
                mo = (i.optimizationStatus || '').toUpperCase() === mlValue;
            }
        }

        return ms && mst && mo;
    });

    // Stats calculation: use Compute Optimizer data for AWS instances, ML data for others
    // Calculate from ALL instances, not just filtered ones
    const optimized = instances.filter(i => {
        const providerLower = (i.provider || '').toLowerCase();
        if (providerLower === 'aws' && i.compute_optimizer_finding) {
            return i.compute_optimizer_finding === 'Optimized';
        }
        return (i.optimizationStatus || '').toUpperCase() === 'OPTIMAL';
    }).length;

    const needsAttn = instances.filter(i => {
        const providerLower = (i.provider || '').toLowerCase();
        if (providerLower === 'aws' && i.compute_optimizer_finding) {
            return ['Overprovisioned', 'Underprovisioned'].includes(i.compute_optimizer_finding);
        }
        return ['OVERSIZED', 'UNDERSIZED', 'OVERUTILIZED', 'UNDERUTILIZED'].includes((i.optimizationStatus || '').toUpperCase());
    }).length;

    // Calculate total savings from standardized field
    const totalSavings = instances.reduce((sum, instance) => {
        return sum + (instance.potential_monthly_savings || 0);
    }, 0);

    console.log(`[Instances] Total savings calculated: $${totalSavings.toFixed(2)} from ${instances.length} instances`);

    // If no savings found, let's debug what fields are available
    if (totalSavings === 0 && instances.length > 0) {
        console.log('[Instances] No savings found. Debugging first instance fields:');
        const firstInstance = instances[0];
        console.log('Available fields:', Object.keys(firstInstance));
        console.log('Sample instance:', firstInstance);
    }

    if (loading && !syncing) return <Loader />;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Auto-fetching banner */}
            {autoFetching && !syncing && (
                <div style={{
                    background: 'var(--az-blue-light)',
                    border: '1px solid var(--az-blue)',
                    borderRadius: 6,
                    padding: '12px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12
                }}>
                    <RefreshCw size={16} style={{ color: 'var(--az-blue)', animation: 'spin 2s linear infinite' }} />
                    <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--az-blue)' }}>
                            Auto-fetching cloud resources...
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--az-text-2)' }}>
                            Loading your instances from connected cloud providers
                        </div>
                    </div>
                </div>
            )}

            {/* Syncing overlay */}
            {syncing && (
                <div style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background: 'rgba(0,0,0,0.5)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 9999
                }}>
                    <div style={{
                        background: '#fff',
                        padding: '32px 48px',
                        borderRadius: 8,
                        textAlign: 'center',
                        boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
                        minWidth: 400
                    }}>
                        <RefreshCw size={40} style={{ color: 'var(--az-blue)', animation: 'spin 1s linear infinite', marginBottom: 16 }} />
                        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Syncing Resources</div>

                        {/* Progress status */}
                        <div style={{ fontSize: 14, color: 'var(--az-blue)', marginBottom: 12, fontWeight: 500 }}>
                            {syncProgress.status}
                        </div>

                        {/* Time elapsed */}
                        <div style={{ fontSize: 13, color: 'var(--az-text-2)', marginBottom: 16 }}>
                            Time elapsed: <span style={{ fontWeight: 600, color: 'var(--az-text)' }}>{syncProgress.elapsed}s</span>
                            {syncProgress.elapsed < 90 && (
                                <span> / Estimated: 30-90s</span>
                            )}
                        </div>

                        {/* Progress bar */}
                        <div style={{
                            width: '100%',
                            height: 6,
                            background: '#E1DFDD',
                            borderRadius: 3,
                            overflow: 'hidden',
                            marginBottom: 12
                        }}>
                            <div style={{
                                height: '100%',
                                width: `${Math.min(100, (syncProgress.elapsed / 90) * 100)}%`,
                                background: 'var(--az-blue)',
                                transition: 'width 1s linear',
                                borderRadius: 3
                            }} />
                        </div>

                        {/* Warning if taking too long */}
                        {syncProgress.elapsed > 90 && (
                            <div style={{
                                fontSize: 12,
                                color: 'var(--az-warning)',
                                background: 'var(--az-warning-bg)',
                                padding: '8px 12px',
                                borderRadius: 4,
                                marginTop: 12
                            }}>
                                ?? Taking longer than expected. This may happen with many instances, multiple regions, or slow network.
                            </div>
                        )}

                        <div style={{ fontSize: 12, color: 'var(--az-text-3)', marginTop: 8 }}>
                            Please wait while we fetch your cloud resources...
                        </div>
                    </div>
                </div>
            )}

            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                <div>
                    <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: 'var(--az-text)' }}>Cloud Instances</h1>
                    <p style={{ margin: '4px 0 0 0', fontSize: 13, color: 'var(--az-text-2)' }}>
                        Manage and optimize your virtual machine instances
                        {instances.length > 0 && (
                            <span style={{ marginLeft: 8, color: 'var(--az-text-3)' }}>
                                � Last synced: {localStorageService.getLastSyncTimeFormatted()}
                            </span>
                        )}
                    </p>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                    <Button
                        onClick={generateReport}
                        disabled={instances.length === 0}
                        variant="secondary"
                        style={{
                            background: '#fff',
                            border: '1px solid var(--az-border)',
                            color: 'var(--az-text)'
                        }}
                    >
                        Generate Report
                    </Button>
                    <Button onClick={handleSyncResources} disabled={syncing} icon={RefreshCw}>
                        {syncing ? 'Syncing...' : 'Sync Resources'}
                    </Button>
                </div>
            </div>

            {/* Stat cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                <StatCard icon={Server} iconBg='#EFF6FF' iconColor='var(--az-blue)' label="Total Instances" value={instances.length} sub={`${optimized} optimized`} />
                <StatCard icon={TrendingDown} iconBg='#DFF6DD' iconColor='var(--az-success)' label="Potential Savings" value={`$${totalSavings.toFixed(2)}`} sub="per month" />
                <StatCard
                    icon={AlertTriangle}
                    iconBg='#FFF4CE'
                    iconColor='var(--az-warning)'
                    label="Needs Attention"
                    value={needsAttn}
                    sub={filterOpt === 'needs_attention' ? 'Click to show all' : 'Click to filter'}
                    onClick={handleNeedsAttentionClick}
                />
            </div>

            {/* Active filter indicator */}
            {filterOpt === 'needs_attention' && (
                <div style={{
                    background: 'var(--az-warning-bg)',
                    border: '1px solid var(--az-warning)',
                    borderRadius: 6,
                    padding: '10px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <AlertTriangle size={16} style={{ color: 'var(--az-warning)' }} />
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--az-warning)' }}>
                            Showing only instances that need attention
                        </span>
                    </div>
                    <Button
                        onClick={() => setFilterOpt('all')}
                        style={{
                            fontSize: 12,
                            padding: '4px 12px',
                            background: '#fff',
                            border: '1px solid var(--az-warning)',
                            color: 'var(--az-warning)'
                        }}
                    >
                        Clear Filter
                    </Button>
                </div>
            )}

            {/* Filter bar */}
            <FadeIn>
                <div style={{ background: '#fff', border: '1px solid var(--az-border)', borderRadius: 6, padding: '10px 16px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                    <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 180 }}>
                        <Search size={13} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--az-text-3)', pointerEvents: 'none' }} />
                        <input className="az-input" style={{ width: '100%', paddingLeft: 28 }} placeholder="Search by name, ID, or region..." value={search} onChange={e => setSearch(e.target.value)} />
                    </div>
                    <select className="az-select" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                        <option value="all">All Status</option>
                        <option value="running">Running</option>
                        <option value="stopped">Stopped</option>
                        <option value="terminated">Terminated</option>
                        <option value="pending">Pending/Starting</option>
                    </select>
                    <select className="az-select" value={filterOpt} onChange={e => setFilterOpt(e.target.value)}>
                        <option value="all">All Optimization</option>
                        <option value="Optimized">Optimized</option>
                        <option value="Overprovisioned">Overprovisioned</option>
                        <option value="Underprovisioned">Underprovisioned</option>
                    </select>
                </div>
            </FadeIn>

            {/* Table */}
            <AnimatedSection>
                <div style={{ background: '#fff', border: '1px solid var(--az-border)', borderRadius: 6, overflow: 'hidden' }}>
                    <div style={{ overflowX: 'auto' }}>
                        <table className="az-table">
                            <thead>
                                <tr>
                                    <th>Provider</th><th>Name / ID</th><th>Type</th><th>CPU Usage</th><th>Memory Usage</th><th>Region</th><th>OS</th><th>Status</th><th>Recommendation</th><th>Potential Savings</th><th>Last Updated</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filtered.length === 0 ? (
                                    <tr><td colSpan={11} style={{ textAlign: 'center', padding: '48px', color: 'var(--az-text-2)' }}>
                                        <Server size={40} style={{ color: 'var(--az-border)', marginBottom: 8, display: 'block', margin: '0 auto 8px' }} />
                                        <div style={{ fontWeight: 500 }}>No instances found</div>
                                        {!hasCloudConnection ? (
                                            <div style={{ fontSize: 12, marginTop: 4 }}>
                                                <div>Connect your cloud account to see instances</div>
                                                <Button
                                                    onClick={() => navigate('/cloud/connect')}
                                                    style={{ marginTop: 12, fontSize: 12 }}
                                                >
                                                    Connect Cloud Account
                                                </Button>
                                            </div>
                                        ) : instances.length === 0 ? (
                                            <div style={{ fontSize: 12, marginTop: 4 }}>
                                                <div>Click "Sync Resources" to fetch your instances</div>
                                                <div style={{ marginTop: 8, color: 'var(--az-text-3)' }}>
                                                    First sync may take 30-60 seconds
                                                </div>
                                            </div>
                                        ) : (
                                            <div style={{ fontSize: 12, marginTop: 4 }}>
                                                <div>No instances match your current filters</div>
                                            </div>
                                        )}
                                    </td></tr>
                                ) : filtered.map(i => (
                                    <tr key={i.resourceId} onClick={() => navigate(`/cloud/resource/${i._id}`, { state: { resource: i } })} style={{ cursor: 'pointer' }}>
                                        <td><ProviderBadge p={i.provider} /></td>
                                        <td>
                                            <div style={{ fontWeight: 500, color: 'var(--az-blue)', fontSize: 13 }}>{i.name}</div>
                                            <div style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--az-text-3)' }}>{i.resourceId}</div>
                                        </td>
                                        <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{i.resourceType}</td>
                                        <td style={{ fontSize: 12, color: 'var(--az-text-2)', textAlign: 'center' }}>
                                            {i.cpu_avg != null ? `${i.cpu_avg.toFixed(1)}%` : i.avgCpuUtilization != null ? `${i.avgCpuUtilization.toFixed(1)}%` : 'N/A'}
                                        </td>
                                        <td style={{ fontSize: 12, color: 'var(--az-text-2)', textAlign: 'center' }}>
                                            {i.memory_avg != null ? `${i.memory_avg.toFixed(1)}%` : i.avgMemoryUtilization != null ? `${i.avgMemoryUtilization.toFixed(1)}%` : 'N/A'}
                                        </td>
                                        <td style={{ fontSize: 12, color: 'var(--az-text-2)' }}>{i.region}</td>
                                        <td style={{ fontSize: 12, color: 'var(--az-text-2)' }}>{i.os_type || 'Unknown'}</td>
                                        <td><StatusBadge status={i.status} /></td>
                                        <td>
                                            {(i.provider === 'aws' || i.provider === 'AWS') && i.compute_optimizer_finding ? (
                                                <OptBadge s={i.compute_optimizer_finding} />
                                            ) : (
                                                <PredictionBadge prediction={i.recommendation} size="sm" />
                                            )}
                                            {i.recommendation_warnings && i.recommendation_warnings.length > 0 && (
                                                <div style={{ marginTop: 4, fontSize: 10, color: 'var(--az-text-3)' }}>
                                                    {i.recommendation_warnings.map((w, idx) => (
                                                        <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                                                            <AlertTriangle size={10} />
                                                            <span>{w}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </td>
                                        <td style={{ fontSize: 12, textAlign: 'right' }}>
                                            {i.potential_monthly_savings != null ? (
                                                i.potential_monthly_savings > 0 ? (
                                                    // Positive savings (Over-Provisioned) - show in green
                                                    <span style={{ color: 'var(--az-success)', fontWeight: 600 }}>
                                                        ${i.potential_monthly_savings.toFixed(2)}/month
                                                    </span>
                                                ) : i.potential_monthly_savings < 0 ? (
                                                    // Negative savings (Under-Provisioned) - show cost increase in red
                                                    <span style={{ color: 'var(--az-error)', fontWeight: 600 }}>
                                                        +${Math.abs(i.potential_monthly_savings).toFixed(2)}/month
                                                    </span>
                                                ) : (
                                                    // Zero savings (Optimized)
                                                    <span style={{ color: 'var(--az-text-2)' }}>$0.00/month</span>
                                                )
                                            ) : (
                                                <span style={{ color: 'var(--az-text-2)' }}>$0.00/month</span>
                                            )}
                                        </td>
                                        <td>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--az-text-3)' }}>
                                                <Clock size={11} />
                                                {formatTimestamp(i.lastFetched)}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </AnimatedSection>

            <style>{`
                @keyframes spin {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                }
            `}</style>

            {/* Toast notifications */}
            {toastState && <Toast message={toastState.message} type={toastState.type} onClose={() => setToastState(null)} />}

            {/* Save Report Modal */}
            {showReportModal && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0, 0, 0, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
                    <div style={{ background: '#fff', borderRadius: 8, padding: '24px', width: '90%', maxWidth: 500, boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)' }}>
                        <h2 style={{ margin: '0 0 8px 0', fontSize: 18, fontWeight: 600, color: 'var(--az-text)' }}>Save Instance Report</h2>
                        <p style={{ margin: '0 0 20px 0', fontSize: 13, color: 'var(--az-text-2)' }}>Enter a name for this report to save it to your reports library.</p>

                        <div style={{ marginBottom: 20 }}>
                            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--az-text)', marginBottom: 6 }}>Report Name *</label>
                            <input
                                type="text"
                                className="az-input"
                                placeholder="e.g., Cloud Instances Q1 2024"
                                value={reportName}
                                onChange={(e) => setReportName(e.target.value)}
                                onKeyPress={(e) => { if (e.key === 'Enter' && reportName.trim()) handleSaveReport(); }}
                                maxLength={100}
                                autoFocus
                                style={{ width: '100%' }}
                            />
                            <div style={{ fontSize: 11, color: 'var(--az-text-3)', marginTop: 4 }}>{reportName.length}/100 characters</div>
                        </div>

                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                            <button onClick={handleCancelModal} className="az-btn az-btn-secondary" style={{ fontSize: 13 }}>
                                Cancel
                            </button>
                            <button
                                onClick={handleSaveReport}
                                disabled={!reportName.trim()}
                                className="az-btn"
                                style={{
                                    background: reportName.trim() ? 'var(--az-blue)' : 'var(--az-border)',
                                    color: reportName.trim() ? '#fff' : 'var(--az-text-3)',
                                    border: 'none',
                                    fontSize: 13,
                                    cursor: reportName.trim() ? 'pointer' : 'not-allowed'
                                }}
                            >
                                <FileText size={14} />Save Report
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
