import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, Server, Cpu, HardDrive, CheckCircle, AlertTriangle, TrendingDown, DollarSign, Activity, Info, ChevronDown, ChevronUp } from 'lucide-react';
import Badge from '../../components/common/Badge';
import Button from '../../components/common/Button';
import Loader from '../../components/common/Loader';
import * as localStorageService from '../../services/localStorageService';
import api from '../../services/api';
import { AnimatedSection, AnimatedContainer, AnimatedItem } from '../../components/animations/AnimatedSection';

// Add CSS animation for loading spinner
const spinnerStyle = `
@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
`;

// Inject the CSS if it doesn't exist
if (!document.querySelector('#spinner-styles')) {
    const style = document.createElement('style');
    style.id = 'spinner-styles';
    style.textContent = spinnerStyle;
    document.head.appendChild(style);
}

const ROW = ({ label, value }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--az-border)' }}>
        <span style={{ fontSize: 12, color: 'var(--az-text-2)' }}>{label}</span>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--az-text)', fontFamily: typeof value === 'string' && value.includes('-') ? 'monospace' : 'inherit' }}>{value}</span>
    </div>
);

// Currency exchange rates (approximate - updated January 2025)
const EXCHANGE_RATES = {
    'INR': 85,    // 1 USD = 85 INR (updated rate)
    'EUR': 0.92,  // 1 USD = 0.92 EUR
    'GBP': 0.79,  // 1 USD = 0.79 GBP
    'JPY': 149,   // 1 USD = 149 JPY
    'CNY': 7.24,  // 1 USD = 7.24 CNY
    'AUD': 1.53,  // 1 USD = 1.53 AUD
    'CAD': 1.36,  // 1 USD = 1.36 CAD
    'USD': 1      // Base currency
};

// Helper function to format currency
const formatCurrency = (amount, currency = 'USD') => {
    const symbols = {
        'USD': '$',
        'INR': '₹',
        'EUR': '€',
        'GBP': '£',
        'JPY': '¥',
        'CNY': '¥',
        'AUD': 'A$',
        'CAD': 'C$'
    };
    const symbol = symbols[currency] || currency + ' ';
    return `${symbol}${amount.toFixed(2)}`;
};

// Helper function to convert currency to USD
const convertToUSD = (amount, fromCurrency = 'USD') => {
    if (fromCurrency === 'USD') return amount;
    const rate = EXCHANGE_RATES[fromCurrency];
    if (!rate) return amount;
    return amount / rate;
};

// Helper function to convert USD to INR
const convertToINR = (usdAmount) => {
    return usdAmount * EXCHANGE_RATES['INR'];
};

// Helper function to format cost with both USD and INR currencies
const formatCostWithConversion = (amount, currency = 'USD') => {
    // Convert to USD first if not already in USD
    const usdAmount = currency === 'USD' ? amount : convertToUSD(amount, currency);
    const inrAmount = convertToINR(usdAmount);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
            <div>{formatCurrency(usdAmount, 'USD')}</div>
            <div style={{ fontSize: 11, color: '#A19F9D' }}>
                ≈ {formatCurrency(inrAmount, 'INR')}
            </div>
        </div>
    );
};

// Helper function to calculate instance age
const getInstanceAge = (launchTime) => {
    if (!launchTime) return null;

    const now = new Date();
    const launch = new Date(launchTime);
    const diffMs = now - launch;
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffHours < 1) return { value: Math.floor(diffMs / (1000 * 60)), unit: 'minutes', isNew: true };
    if (diffHours < 24) return { value: diffHours, unit: 'hours', isNew: diffHours < 2 };
    if (diffDays < 7) return { value: diffDays, unit: 'days', isNew: diffDays < 1 };
    if (diffDays < 30) return { value: Math.floor(diffDays / 7), unit: 'weeks', isNew: false };
    return { value: Math.floor(diffDays / 30), unit: 'months', isNew: false };
};

// Helper function to get intelligent data availability message
const getDataAvailabilityMessage = (resource, selectedRange, metricsError) => {
    const instanceAge = getInstanceAge(resource.launchTime || resource.createdAt || resource.created_at);
    const rangeHours = convertRangeToHours(selectedRange);

    // If we have instance age information
    if (instanceAge) {
        const ageInHours = instanceAge.unit === 'minutes' ? instanceAge.value / 60 :
            instanceAge.unit === 'hours' ? instanceAge.value :
                instanceAge.unit === 'days' ? instanceAge.value * 24 :
                    instanceAge.unit === 'weeks' ? instanceAge.value * 24 * 7 :
                        instanceAge.value * 24 * 30;

        // Instance is newer than the requested time range
        if (ageInHours < rangeHours) {
            return {
                type: 'info',
                title: 'Instance Too New',
                message: `This instance was started ${instanceAge.value} ${instanceAge.unit} ago, but you're requesting ${getTimeRangeLabel(selectedRange)} of data.`,
                suggestion: `Try a shorter time range like "${ageInHours < 1 ? '15m' : ageInHours < 3 ? '1h' : ageInHours < 12 ? '3h' : '12h'}" to see available data.`,
                icon: 'info'
            };
        }

        // Instance is very new (less than 1 hour)
        if (instanceAge.isNew && instanceAge.unit === 'minutes') {
            return {
                type: 'warning',
                title: 'Very New Instance',
                message: `Instance started ${instanceAge.value} minutes ago. Metrics collection may still be initializing.`,
                suggestion: 'Wait a few more minutes for metrics to become available, then try refreshing.',
                icon: 'clock'
            };
        }

        // Instance is new (less than 2 hours)
        if (instanceAge.isNew && instanceAge.unit === 'hours') {
            return {
                type: 'warning',
                title: 'New Instance',
                message: `Instance started ${instanceAge.value} hour${instanceAge.value > 1 ? 's' : ''} ago. Limited metrics data available.`,
                suggestion: 'Some metrics may not be available yet. Try shorter time ranges for better data coverage.',
                icon: 'clock'
            };
        }
    }

    // Provider-specific messages
    if (resource.provider === 'GCP') {
        return {
            type: 'info',
            title: 'GCP Metrics Unavailable',
            message: 'GCP Cloud Monitoring data is not available for the selected time range.',
            suggestion: 'GCP metrics may take time to populate. Try a different time range or check back later.',
            icon: 'info'
        };
    }

    if (resource.provider === 'AWS') {
        return {
            type: 'warning',
            title: 'CloudWatch Data Unavailable',
            message: 'AWS CloudWatch metrics are not available for the selected time range.',
            suggestion: 'Ensure CloudWatch monitoring is enabled and try a different time range.',
            icon: 'warning'
        };
    }

    if (resource.provider === 'Azure') {
        return {
            type: 'info',
            title: 'Azure Monitor Data Unavailable',
            message: 'Azure Monitor metrics are not available for the selected time range.',
            suggestion: 'Azure metrics may be delayed. Try refreshing or selecting a different time range.',
            icon: 'info'
        };
    }

    // Generic fallback
    return {
        type: 'error',
        title: 'Metrics Data Unavailable',
        message: metricsError || 'No metrics data available for the selected time range.',
        suggestion: 'Try selecting a different time range or check back later.',
        icon: 'error'
    };
};

// Helper function to get human-readable time range labels
const getTimeRangeLabel = (range) => {
    const labels = {
        '15m': '15 minutes',
        '30m': '30 minutes',
        '1h': '1 hour',
        '3h': '3 hours',
        '6h': '6 hours',
        '12h': '12 hours',
        '1d': '1 day',
        '2d': '2 days',
        '3d': '3 days',
        '7d': '7 days',
        '14d': '14 days',
        '30d': '30 days',
        // Legacy support
        '1w': '7 days'
    };
    return labels[range] || range;
};

// Helper function to convert time range to hours for API calls
const convertRangeToHours = (range) => {
    const conversions = {
        '15m': 0.25,
        '30m': 0.5,
        '1h': 1,
        '3h': 3,
        '6h': 6,
        '12h': 12,
        '1d': 24,
        '2d': 48,
        '3d': 72,
        '7d': 168,
        '14d': 336,
        '30d': 720,
        // Legacy support
        '1w': 168
    };
    return conversions[range] || 3; // Default to 3 hours
};

// Helper function to format relative time
const getRelativeTime = (dateString) => {
    if (!dateString) return 'Unknown';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    return date.toLocaleDateString();
};

const BAR = ({ label, value, isRunning, showTooltip = false, memoryMetricsSource }) => {
    // Check for null/undefined explicitly (not just falsy)
    const isNull = value === null || value === undefined;
    const requiresAgent = memoryMetricsSource === 'agent_required';

    if (!isRunning || isNull) {
        return (
            <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                    <span style={{ color: 'var(--az-text-2)' }}>{label}</span>
                    <span style={{ fontWeight: 600, color: 'var(--az-text-3)', display: 'flex', alignItems: 'center', gap: 4 }}>
                        N/A
                        {isNull && showTooltip && (
                            <span title="Memory metrics require CloudWatch Agent inside the instance." style={{ cursor: 'help' }}>
                                <Info size={12} style={{ color: 'var(--az-text-3)' }} />
                            </span>
                        )}
                    </span>
                </div>
                <div style={{ height: 6, background: 'var(--az-border)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: '0%', background: 'var(--az-border)', borderRadius: 3 }} />
                </div>
                {requiresAgent && isRunning && (
                    <div style={{ marginTop: 6, fontSize: 10, color: 'var(--az-warning)', background: 'var(--az-warning-bg)', padding: '6px 8px', borderRadius: 3, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <AlertTriangle size={10} />
                        <span>Memory metrics require CloudWatch Agent installation</span>
                    </div>
                )}
            </div>
        );
    }

    const pct = Math.min(100, Math.max(0, parseFloat(value) || 0));
    // Updated color thresholds: 0-30% green, 30-70% yellow, 70-100% red
    const getColor = (val) => {
        if (val >= 70) return 'var(--az-error)';      // Red
        if (val >= 30) return 'var(--az-warning)';    // Yellow
        return '#107C10';                              // Green
    };
    const color = getColor(pct);

    return (
        <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: 'var(--az-text-2)' }}>{label}</span>
                <span style={{ fontWeight: 600, color }}>{pct.toFixed(2)}%</span>
            </div>
            <div style={{ height: 6, background: 'var(--az-border)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width 0.4s' }} />
            </div>
        </div>
    );
};

export default function ResourceDetail() {
    const { id } = useParams();
    const navigate = useNavigate();
    const { state } = useLocation();
    const [resource, setResource] = useState(state?.resource || null);
    const [loading, setLoading] = useState(!state?.resource);
    const [savingsExpanded, setSavingsExpanded] = useState(false);

    // Real-time metrics state with enhanced time range support
    const [selectedRange, setSelectedRange] = useState('1h'); // Default to 1 hour for better performance
    const [realtimeMetrics, setRealtimeMetrics] = useState(null);
    const [metricsLoading, setMetricsLoading] = useState(false);
    const [metricsError, setMetricsError] = useState(null);

    // Compute Optimizer recommendation state
    const [computeOptimizerRec, setComputeOptimizerRec] = useState(null);
    const [coLoading, setCoLoading] = useState(false);
    const [coError, setCoError] = useState(null);

    // Load resource from localStorage
    useEffect(() => {
        if (!resource) {
            setLoading(true);
            const loadedResource = localStorageService.getResourceById(id);
            if (loadedResource) {
                setResource(loadedResource);
            } else {
                console.warn('[ResourceDetail] Resource not found in localStorage:', id);
                // Redirect to instances page if not found
                setTimeout(() => {
                    navigate('/cloud/instances');
                }, 2000);
            }
            setLoading(false);
        }
    }, [id, resource, navigate]);

    // Fetch metrics from all cloud providers
    useEffect(() => {
        if (!resource || !resource.resourceId) {
            return;
        }

        let isMounted = true;

        const fetchMetrics = async () => {
            try {
                setMetricsLoading(true);

                // Convert range to hours for API compatibility
                const rangeHours = convertRangeToHours(selectedRange);

                let response;

                // Provider-specific metric fetching
                if (resource.provider === 'AWS') {
                    // AWS CloudWatch real-time metrics - use enhanced endpoint
                    response = await api.get(`/resources/instances/${resource.resourceId}/enhanced-usage?range=${selectedRange}&hours=${rangeHours}`);
                } else if (resource.provider === 'GCP') {
                    // GCP Cloud Monitoring metrics
                    response = await api.get(`/resources/instances/${resource.resourceId}/gcp-metrics?range=${selectedRange}&hours=${rangeHours}`);
                } else if (resource.provider === 'Azure') {
                    // Azure Monitor metrics
                    response = await api.get(`/resources/instances/${resource.resourceId}/azure-metrics?range=${selectedRange}&hours=${rangeHours}`);
                } else {
                    // Fallback for other providers
                    console.log(`[Metrics] Provider ${resource.provider} not supported for real-time metrics`);
                    return;
                }

                if (isMounted && response?.data) {
                    // Enhance response data with range information
                    const enhancedData = {
                        ...response.data,
                        range: selectedRange,
                        rangeLabel: getTimeRangeLabel(selectedRange),
                        provider: resource.provider,
                        lastUpdated: new Date().toISOString(),
                        dataPoints: response.data.dataPoints || 0,
                        resolution: response.data.resolution || (rangeHours <= 6 ? '1min' : rangeHours <= 24 ? '5min' : '1hour')
                    };

                    setRealtimeMetrics(enhancedData);
                    setMetricsError(null);

                    console.log(`[Metrics] Successfully fetched ${resource.provider} metrics for ${selectedRange}:`, enhancedData);
                }
            } catch (error) {
                console.error(`[ResourceDetail] Failed to fetch ${resource.provider} metrics:`, error);
                if (isMounted) {
                    const errorMessage = error.response?.data?.message ||
                        `Failed to load ${resource.provider} metrics for ${getTimeRangeLabel(selectedRange)}`;
                    setMetricsError(errorMessage);
                    // Keep previous metrics if available
                }
            } finally {
                if (isMounted) {
                    setMetricsLoading(false);
                }
            }
        };

        // Initial fetch
        fetchMetrics();

        // Set up auto-refresh based on time range and provider
        let refreshInterval;
        if (resource.provider === 'AWS') {
            // AWS: More frequent updates for shorter ranges
            refreshInterval = selectedRange.includes('m') || selectedRange === '1h' ? 30000 : 60000; // 30s or 60s
        } else if (resource.provider === 'GCP') {
            // GCP: Less frequent updates for historical data
            refreshInterval = 120000; // 2 minutes
        } else if (resource.provider === 'Azure') {
            // Azure: Moderate refresh for cached data
            refreshInterval = 90000; // 1.5 minutes
        }

        const intervalId = refreshInterval ? setInterval(fetchMetrics, refreshInterval) : null;

        // Cleanup on unmount or when dependencies change
        return () => {
            isMounted = false;
            if (intervalId) {
                clearInterval(intervalId);
            }
        };
    }, [resource, selectedRange]);

    // Fetch Compute Optimizer recommendation
    useEffect(() => {
        if (!resource || !resource.resourceId || resource.provider !== 'AWS') {
            console.log('[Compute Optimizer] Skipping fetch - not an AWS instance', { resource: resource?.resourceId, provider: resource?.provider });
            return;
        }

        let isMounted = true;

        const fetchComputeOptimizerRec = async () => {
            try {
                console.log('[Compute Optimizer] Fetching recommendation for instance:', resource.resourceId);
                setCoLoading(true);
                const response = await api.get(`/resources/instances/${resource.resourceId}/compute-optimizer`);

                console.log('[Compute Optimizer] API Response:', response.data);

                if (isMounted) {
                    if (response.data.hasRecommendation) {
                        console.log('[Compute Optimizer] Recommendation found:', response.data.recommendation);
                        setComputeOptimizerRec(response.data.recommendation);
                    } else {
                        console.log('[Compute Optimizer] No recommendation available:', response.data.message);
                        setComputeOptimizerRec(null);
                    }
                    setCoError(null);
                }
            } catch (error) {
                console.error('[Compute Optimizer] API Error:', error);
                console.error('[Compute Optimizer] Error details:', error.response?.data);
                if (isMounted) {
                    setCoError(error.response?.data?.message || 'Failed to load Compute Optimizer recommendation');
                    setComputeOptimizerRec(null);
                }
            } finally {
                if (isMounted) {
                    setCoLoading(false);
                }
            }
        };

        // Initial fetch
        fetchComputeOptimizerRec();

        // Cleanup on unmount
        return () => {
            isMounted = false;
        };
    }, [resource]);

    if (loading) return <Loader text="Loading resource details..." />;
    if (!resource) return (
        <div style={{ textAlign: 'center', padding: 40 }}>
            <p style={{ color: 'var(--az-text-2)', marginBottom: 12 }}>Resource not found in localStorage.</p>
            <p style={{ fontSize: 12, color: 'var(--az-text-3)', marginBottom: 12 }}>
                The resource may not have been synced yet. Redirecting to instances page...
            </p>
            <Button onClick={() => navigate('/cloud/instances')}>← Back to Instances</Button>
        </div>
    );

    const isOptimal = computeOptimizerRec?.finding === 'Optimized' ||
        (!computeOptimizerRec && (resource.optimizationStatus === 'OPTIMAL' || resource.optimizationStatus === 'optimal' || resource.finding === 'Optimal'));
    const savings = computeOptimizerRec?.estimated_monthly_savings || resource.estimated_monthly_savings || resource.savings || 0;

    // COST DISPLAY FIX: Use Compute Optimizer cost data if available
    // Priority: 1) Compute Optimizer current_monthly_cost, 2) Resource cost fields
    const currentCost = computeOptimizerRec?.current_monthly_cost || resource.estimatedMonthlyCost || resource.currentCost || resource.cost || 0;

    const cpuAvg = resource.avgCpuUtilization ?? resource.cpuAvg ?? resource.cpu_avg ?? null;
    const memAvg = resource.avgMemoryUtilization ?? resource.memoryAvg ?? resource.memory_avg ?? null;
    const memoryMetricsSource = resource.memory_metrics_source || resource.memoryMetricsSource;
    const missingMetrics = resource.missing_metrics || resource.missingMetrics || [];
    const metricsStatus = resource.metrics_status || resource.metricsStatus;
    const metricsWindowDays = resource.metrics_window_days || resource.metricsWindowDays || 30;
    const runningHours = resource.running_hours_last_14d || resource.runningHoursLast14d;

    // Check if instance is running/stopped/terminated
    const instanceState = (resource.state || '').toLowerCase();
    const isRunning = instanceState === 'running' || instanceState === 'active';
    const isStopped = instanceState === 'stopped' || instanceState === 'deallocated';
    const isTerminated = instanceState === 'terminated' || instanceState === 'deleted';

    // Pricing source information
    const priceSource = resource.price_source || resource.priceSource || 'cached';
    const priceLastUpdated = resource.price_last_updated || resource.priceLastUpdated;
    const fallbackReason = resource.fallback_reason || resource.fallbackReason;
    const isLivePricing = priceSource === 'live';
    const isCachedPricing = priceSource === 'cached';
    const isDatabasePricing = priceSource === 'database';
    const isUnavailablePricing = priceSource === 'unavailable';

    // Prediction confidence (convert to percentage if needed)
    const predictionConfidence = resource.prediction_confidence || resource.predictionConfidence || 0;
    const confidencePercent = predictionConfidence > 1 ? predictionConfidence : predictionConfidence * 100;
    const confidenceFlag = resource.confidence_flag || resource.confidenceFlag;
    const isHighConfidence = confidencePercent >= 75;
    const isLowConfidence = confidencePercent < 50;

    // Check if we have ANY recommendation (Compute Optimizer OR ML)
    const hasRecommendation = computeOptimizerRec?.recommended_instance_type || resource.recommendedType || resource.recommended_instance;

    // Check for GCP-specific recommendation availability
    const hasGCPRecommendation = resource.provider === 'GCP' && resource.has_gcp_recommendation === true;
    const noGCPRecommendationsAvailable = resource.provider === 'GCP' && resource.has_gcp_recommendation === false;

    // If Compute Optimizer data exists, use it to determine if we should show recommendations
    const hasComputeOptimizerData = computeOptimizerRec !== null;
    const shouldShowRecommendations = hasComputeOptimizerData || hasRecommendation || hasGCPRecommendation;

    // Architecture & compatibility info
    const architecture = resource.architecture || 'x86_64';
    const instanceFamily = resource.instance_family || resource.instanceFamily;
    const isAvailableInRegion = resource.available_in_region !== false;

    // Determine status badge
    const getStatusBadge = () => {
        if (isStopped) return { variant: 'default', text: 'Stopped' };
        if (isTerminated) return { variant: 'default', text: 'Terminated' };

        // Prioritize Compute Optimizer finding if available
        if (computeOptimizerRec) {
            console.log('[ResourceDetail] Compute Optimizer finding:', computeOptimizerRec.finding);
            if (computeOptimizerRec.finding === 'Overprovisioned') {
                return { variant: 'warning', text: 'Over-Provisioned' };
            }
            if (computeOptimizerRec.finding === 'Underprovisioned') {
                return { variant: 'error', text: 'Under-Provisioned' };
            }
            if (computeOptimizerRec.finding === 'Optimized') {
                return { variant: 'success', text: 'Optimized' };
            }
        } else {
            console.log('[ResourceDetail] No Compute Optimizer recommendation available');
        }

        // Fallback to ML-based status
        // Check for null explicitly - CPU is required, memory is optional
        if (cpuAvg === null || cpuAvg === undefined) return { variant: 'default', text: 'Insufficient Data' };
        if (isOptimal) return { variant: 'success', text: 'Optimized' };
        // Allow "Needs Optimization" even if memory is null (as long as CPU is present)
        if (isRunning && confidencePercent >= 50) return { variant: 'warning', text: 'Needs Optimization' };
        return { variant: 'default', text: 'Insufficient Data' };
    };

    const statusBadge = getStatusBadge();

    // COST DISPLAY FIX: Calculate costs for stopped instances and recommendations
    // Use Compute Optimizer recommendation option cost if available
    const displayCurrentCost = isStopped ? 0 : currentCost;
    const recommendedCost = computeOptimizerRec?.recommendation_options?.[0]?.monthly_cost
        ? (isStopped ? 0 : computeOptimizerRec.recommendation_options[0].monthly_cost)
        : (displayCurrentCost - savings);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: '100%', padding: '0 20px' }}>
            {/* Breadcrumb */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <button onClick={() => navigate('/cloud/dashboard')} style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', color: 'var(--az-blue)', cursor: 'pointer', fontSize: 13, padding: 0 }}>
                    <ArrowLeft size={14} /> Dashboard
                </button>
                <span style={{ color: 'var(--az-text-3)' }}>/</span>
                <button onClick={() => navigate('/cloud/instances')} style={{ background: 'none', border: 'none', color: 'var(--az-blue)', cursor: 'pointer', fontSize: 13, padding: 0 }}>
                    Instances
                </button>
                <span style={{ color: 'var(--az-text-3)' }}>/</span>
                <span style={{ color: 'var(--az-text-2)' }}>{resource.name}</span>
            </div>

            {/* Over-Provisioned Warning Banner (AWS Compute Optimizer Style) */}
            {computeOptimizerRec && computeOptimizerRec.finding === 'Overprovisioned' && (
                <div style={{
                    background: '#FFF4CE',
                    border: '1px solid #F0AD4E',
                    borderRadius: 4,
                    padding: '12px 16px',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12
                }}>
                    <AlertTriangle size={20} style={{ color: '#F0AD4E', flexShrink: 0, marginTop: 2 }} />
                    <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: '#333', marginBottom: 4 }}>
                            {resource.resourceId} is over-provisioned
                        </div>
                        <div style={{ fontSize: 13, color: '#666', lineHeight: 1.5 }}>
                            Compute Optimizer found that this instance's CPU, Memory, EBS throughput, EBS IOPS and network bandwidth are over-provisioned.
                        </div>
                    </div>
                </div>
            )}

            {/* Under-Provisioned Warning Banner */}
            {computeOptimizerRec && computeOptimizerRec.finding === 'Underprovisioned' && (
                <div style={{
                    background: '#FFE5E5',
                    border: '1px solid #D32F2F',
                    borderRadius: 4,
                    padding: '12px 16px',
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12
                }}>
                    <AlertTriangle size={20} style={{ color: '#D32F2F', flexShrink: 0, marginTop: 2 }} />
                    <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: '#333', marginBottom: 4 }}>
                            {resource.resourceId} is under-provisioned
                        </div>
                        <div style={{ fontSize: 13, color: '#666', lineHeight: 1.5 }}>
                            Compute Optimizer found that this instance needs more resources to handle its workload effectively.
                        </div>
                    </div>
                </div>
            )}

            {/* Page header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div>
                    <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: 'var(--az-text)' }}>{resource.name}</h1>
                    <div style={{ display: 'flex', gap: 16, marginTop: 4, flexWrap: 'wrap' }}>
                        {[['ID', resource.resourceId], ['Provider', resource.provider], ['Region', resource.region]].map(([k, v]) => (
                            <span key={k} style={{ fontSize: 12, color: 'var(--az-text-2)' }}><b style={{ color: 'var(--az-text)' }}>{k}:</b> {v}</span>
                        ))}
                        {resource.provider === 'GCP' && resource.zone && (
                            <span style={{ fontSize: 12, color: 'var(--az-text-2)' }}>
                                <b style={{ color: 'var(--az-text)' }}>Zone:</b> {resource.zone}
                            </span>
                        )}
                        {[['Type', resource.resourceType]].map(([k, v]) => (
                            <span key={k} style={{ fontSize: 12, color: 'var(--az-text-2)' }}><b style={{ color: 'var(--az-text)' }}>{k}:</b> {v}</span>
                        ))}
                        {resource.os_type && (
                            <span style={{ fontSize: 12, color: 'var(--az-text-2)' }} title={resource.os_type === 'unknown' ? 'OS: Unknown (unable to detect from cloud)' : ''}>
                                <b style={{ color: 'var(--az-text)' }}>OS:</b> {resource.os_type === 'unknown' ? 'Unknown' : resource.os_type}
                            </span>
                        )}
                        {resource.state && (
                            <span style={{ fontSize: 12, color: 'var(--az-text-2)' }}>
                                <b style={{ color: 'var(--az-text)' }}>State:</b>{' '}
                                <span style={{
                                    padding: '2px 6px',
                                    borderRadius: 3,
                                    fontSize: 11,
                                    fontWeight: 600,
                                    background: isRunning ? 'var(--az-success-bg)' : isTerminated ? '#f3f2f1' : 'var(--az-warning-bg)',
                                    color: isRunning ? 'var(--az-success)' : isTerminated ? 'var(--az-text-3)' : 'var(--az-warning)'
                                }}>
                                    {resource.state}
                                </span>
                            </span>
                        )}
                        {resource.running_hours_last_14d !== undefined && resource.running_hours_last_14d !== null && (
                            <span style={{ fontSize: 12, color: 'var(--az-text-2)' }}>
                                <b style={{ color: 'var(--az-text)' }}>Running Hours (Last 14 Days):</b> {Math.round(resource.running_hours_last_14d)}h
                            </span>
                        )}
                        {(() => {
                            const instanceAge = getInstanceAge(resource.launchTime || resource.createdAt || resource.created_at);
                            if (instanceAge) {
                                const ageColor = instanceAge.isNew ? 'var(--az-warning)' : 'var(--az-text)';
                                const ageBg = instanceAge.isNew ? 'var(--az-warning-bg)' : 'transparent';
                                return (
                                    <span style={{ fontSize: 12, color: 'var(--az-text-2)' }}>
                                        <b style={{ color: 'var(--az-text)' }}>Instance Age:</b>{' '}
                                        <span style={{
                                            color: ageColor,
                                            background: ageBg,
                                            padding: instanceAge.isNew ? '2px 6px' : '0',
                                            borderRadius: instanceAge.isNew ? 3 : 0,
                                            fontWeight: instanceAge.isNew ? 600 : 'normal'
                                        }}>
                                            {instanceAge.value} {instanceAge.unit}
                                            {instanceAge.isNew && ' (New)'}
                                        </span>
                                    </span>
                                );
                            }
                            return null;
                        })()}
                    </div>
                </div>
                <Badge variant={statusBadge.variant}>{statusBadge.text}</Badge>
            </div>

            {/* Content grid */}
            <AnimatedSection>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

                    {/* Current Instance */}
                    <div style={{ background: '#fff', border: '1px solid var(--az-border)', borderRadius: 6, overflow: 'hidden' }}>
                        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--az-border)', background: 'var(--az-surface)', display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Server size={15} style={{ color: 'var(--az-text-2)' }} />
                            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--az-text)' }}>Current Configuration</span>
                        </div>
                        <div style={{ padding: '16px' }}>
                            {/* Highlight type */}
                            <div style={{ background: 'var(--az-bg)', border: '1px solid var(--az-border)', borderRadius: 4, padding: '10px 14px', marginBottom: 12 }}>
                                <div style={{ fontSize: 11, color: 'var(--az-text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Instance Type</div>
                                <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'monospace', color: 'var(--az-text)' }}>{resource.resourceType || resource.instanceType}</div>
                            </div>

                            {/* Specs */}
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                                {[['vCPU', resource.vCpu || resource.vcpu || resource.vcpuCount || 'N/A', 'var(--az-blue)', Cpu], ['Memory', `${resource.memoryGb || resource.memory || resource.ramGb || 'N/A'} GB`, '#7B2FBE', HardDrive]].map(([l, v, c, Icon]) => (
                                    <div key={l} style={{ border: '1px solid var(--az-border)', borderRadius: 4, padding: '8px 12px', display: 'flex', gap: 8, alignItems: 'center' }}>
                                        <div style={{ width: 28, height: 28, borderRadius: 4, background: c + '22', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                            <Icon size={14} style={{ color: c }} />
                                        </div>
                                        <div>
                                            <div style={{ fontSize: 11, color: 'var(--az-text-3)' }}>{l}</div>
                                            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--az-text)' }}>{v}</div>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            {/* Enhanced Time Range Selector for All Providers */}
                            {isRunning && (
                                <div style={{ marginBottom: 16 }}>
                                    <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--az-text-3)', letterSpacing: '0.05em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                                        Metrics Time Range
                                        {metricsLoading && (
                                            <div style={{ width: 12, height: 12, border: '2px solid var(--az-border)', borderTop: '2px solid var(--az-blue)', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                                        )}
                                        {resource.provider === 'AWS' && (
                                            <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 500, color: 'var(--az-success)', background: 'var(--az-success-bg)', padding: '2px 6px', borderRadius: 3 }}>
                                                Real-Time
                                            </span>
                                        )}
                                        {resource.provider === 'GCP' && (
                                            <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 500, color: 'var(--az-blue)', background: 'var(--az-blue-light)', padding: '2px 6px', borderRadius: 3 }}>
                                                Historical
                                            </span>
                                        )}
                                        {resource.provider === 'Azure' && (
                                            <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 500, color: 'var(--az-warning)', background: 'var(--az-warning-bg)', padding: '2px 6px', borderRadius: 3 }}>
                                                Cached
                                            </span>
                                        )}
                                    </div>

                                    {/* Time Range Categories */}
                                    <div style={{ marginBottom: 12 }}>
                                        {/* Minutes & Hours */}
                                        <div style={{ marginBottom: 8 }}>
                                            <div style={{ fontSize: 10, color: 'var(--az-text-3)', marginBottom: 4, fontWeight: 600 }}>RECENT</div>
                                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                                {['15m', '30m', '1h', '3h', '6h', '12h'].map((range) => (
                                                    <button
                                                        key={range}
                                                        onClick={() => setSelectedRange(range)}
                                                        style={{
                                                            padding: '4px 8px',
                                                            fontSize: 10,
                                                            fontWeight: 600,
                                                            border: '1px solid var(--az-border)',
                                                            borderRadius: 3,
                                                            background: selectedRange === range ? 'var(--az-blue)' : '#fff',
                                                            color: selectedRange === range ? '#fff' : 'var(--az-text-2)',
                                                            cursor: 'pointer',
                                                            transition: 'all 0.2s',
                                                            fontFamily: 'inherit',
                                                            minWidth: '32px'
                                                        }}
                                                        onMouseEnter={(e) => {
                                                            if (selectedRange !== range) {
                                                                e.target.style.background = 'var(--az-surface)';
                                                            }
                                                        }}
                                                        onMouseLeave={(e) => {
                                                            if (selectedRange !== range) {
                                                                e.target.style.background = '#fff';
                                                            }
                                                        }}
                                                    >
                                                        {range}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>

                                        {/* Days & Weeks */}
                                        <div style={{ marginBottom: 8 }}>
                                            <div style={{ fontSize: 10, color: 'var(--az-text-3)', marginBottom: 4, fontWeight: 600 }}>EXTENDED</div>
                                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                                {['1d', '2d', '3d', '7d', '14d', '30d'].map((range) => (
                                                    <button
                                                        key={range}
                                                        onClick={() => setSelectedRange(range)}
                                                        style={{
                                                            padding: '4px 8px',
                                                            fontSize: 10,
                                                            fontWeight: 600,
                                                            border: '1px solid var(--az-border)',
                                                            borderRadius: 3,
                                                            background: selectedRange === range ? 'var(--az-blue)' : '#fff',
                                                            color: selectedRange === range ? '#fff' : 'var(--az-text-2)',
                                                            cursor: 'pointer',
                                                            transition: 'all 0.2s',
                                                            fontFamily: 'inherit',
                                                            minWidth: '32px'
                                                        }}
                                                        onMouseEnter={(e) => {
                                                            if (selectedRange !== range) {
                                                                e.target.style.background = 'var(--az-surface)';
                                                            }
                                                        }}
                                                        onMouseLeave={(e) => {
                                                            if (selectedRange !== range) {
                                                                e.target.style.background = '#fff';
                                                            }
                                                        }}
                                                    >
                                                        {range}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Enhanced Metrics Status and Errors */}
                                    {(metricsError || (!realtimeMetrics && !metricsLoading)) && (
                                        <div style={{ marginBottom: 12 }}>
                                            {(() => {
                                                const message = getDataAvailabilityMessage(resource, selectedRange, metricsError);
                                                const bgColor = message.type === 'error' ? 'var(--az-error-bg)' :
                                                    message.type === 'warning' ? 'var(--az-warning-bg)' :
                                                        'var(--az-blue-light)';
                                                const borderColor = message.type === 'error' ? 'var(--az-error)' :
                                                    message.type === 'warning' ? 'var(--az-warning)' :
                                                        'var(--az-blue)';
                                                const iconColor = message.type === 'error' ? 'var(--az-error)' :
                                                    message.type === 'warning' ? 'var(--az-warning)' :
                                                        'var(--az-blue)';

                                                return (
                                                    <div style={{
                                                        background: bgColor,
                                                        border: `1px solid ${borderColor}`,
                                                        borderRadius: 4,
                                                        padding: '12px 14px'
                                                    }}>
                                                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                                                            <div style={{ marginTop: 1 }}>
                                                                {message.icon === 'error' && <AlertTriangle size={16} style={{ color: iconColor }} />}
                                                                {message.icon === 'warning' && <AlertTriangle size={16} style={{ color: iconColor }} />}
                                                                {message.icon === 'info' && <Info size={16} style={{ color: iconColor }} />}
                                                                {message.icon === 'clock' && <Activity size={16} style={{ color: iconColor }} />}
                                                            </div>
                                                            <div style={{ flex: 1 }}>
                                                                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--az-text)', marginBottom: 4 }}>
                                                                    {message.title}
                                                                </div>
                                                                <div style={{ fontSize: 11, color: 'var(--az-text-2)', marginBottom: 6, lineHeight: 1.4 }}>
                                                                    {message.message}
                                                                </div>
                                                                <div style={{ fontSize: 10, color: iconColor, fontWeight: 500 }}>
                                                                    💡 {message.suggestion}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            })()}
                                        </div>
                                    )}

                                    {/* Metrics Info Display */}
                                    {realtimeMetrics && (
                                        <div style={{ fontSize: 10, color: 'var(--az-text-3)', marginBottom: 8, padding: '6px 8px', background: 'var(--az-surface)', borderRadius: 3 }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                <span>Last updated: {new Date(realtimeMetrics.lastUpdated).toLocaleTimeString()}</span>
                                                <span>Range: {getTimeRangeLabel(selectedRange)}</span>
                                            </div>
                                            {realtimeMetrics.dataPoints && (
                                                <div style={{ marginTop: 2 }}>
                                                    Data points: {realtimeMetrics.dataPoints} • Resolution: {realtimeMetrics.resolution || 'Auto'}
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {/* Provider-specific Information */}
                                    <div style={{ fontSize: 10, color: 'var(--az-text-3)', marginBottom: 8, padding: '6px 8px', background: 'var(--az-blue-light)', borderRadius: 3 }}>
                                        {resource.provider === 'AWS' && (
                                            <div>
                                                <strong>AWS CloudWatch:</strong> Real-time metrics with 1-5 minute resolution.
                                                {selectedRange.includes('m') || selectedRange.includes('h') ? ' High resolution data.' : ' Standard resolution data.'}
                                            </div>
                                        )}
                                        {resource.provider === 'GCP' && (
                                            <div>
                                                <strong>GCP Monitoring:</strong> Historical metrics from Cloud Monitoring API.
                                                Data available for up to 30 days with varying resolution.
                                            </div>
                                        )}
                                        {resource.provider === 'Azure' && (
                                            <div>
                                                <strong>Azure Monitor:</strong> Cached metrics from Azure Monitor API.
                                                Data refreshed every 15 minutes for optimal performance.
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Usage bars */}
                            <div style={{ marginBottom: 12 }}>
                                <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--az-text-3)', letterSpacing: '0.05em', marginBottom: 8 }}>
                                    Current Usage
                                    {!isRunning && (
                                        <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 500, color: 'var(--az-warning)', background: 'var(--az-warning-bg)', padding: '2px 6px', borderRadius: 3 }}>
                                            Instance {isTerminated ? 'Terminated' : 'Stopped'}
                                        </span>
                                    )}
                                </div>

                                {/* Enhanced Metrics Window Display with Instance Age */}
                                {isRunning && (
                                    <div style={{ fontSize: 11, color: 'var(--az-text-3)', marginBottom: 8 }}>
                                        {(() => {
                                            const instanceAge = getInstanceAge(resource.launchTime || resource.createdAt || resource.created_at);
                                            const baseText = `Usage data based on last ${metricsWindowDays} days`;

                                            if (instanceAge) {
                                                const ageInHours = instanceAge.unit === 'minutes' ? instanceAge.value / 60 :
                                                    instanceAge.unit === 'hours' ? instanceAge.value :
                                                        instanceAge.unit === 'days' ? instanceAge.value * 24 :
                                                            instanceAge.unit === 'weeks' ? instanceAge.value * 24 * 7 :
                                                                instanceAge.value * 24 * 30;

                                                const maxDataHours = metricsWindowDays * 24;

                                                if (ageInHours < maxDataHours) {
                                                    return (
                                                        <div>
                                                            {baseText}
                                                            <span style={{ marginLeft: 8, color: 'var(--az-blue)', fontWeight: 600 }}>
                                                                📅 Instance age: {instanceAge.value} {instanceAge.unit}
                                                            </span>
                                                            {ageInHours < 24 && (
                                                                <span style={{ marginLeft: 8, color: 'var(--az-warning)' }}>
                                                                    ⚠️ Limited data available for new instance
                                                                </span>
                                                            )}
                                                        </div>
                                                    );
                                                }
                                            }

                                            return (
                                                <div>
                                                    {baseText}
                                                    {runningHours && metricsWindowDays &&
                                                        runningHours < (metricsWindowDays * 24) && (
                                                            <span style={{ marginLeft: 8, color: 'var(--az-warning)' }}>
                                                                ⚠️ Instance only ran {runningHours}h during this period — recommendation confidence may be reduced
                                                            </span>
                                                        )}
                                                </div>
                                            );
                                        })()}
                                    </div>
                                )}

                                {/* Metrics Status Display */}
                                {metricsStatus === 'instance_stopped' && (
                                    <div style={{ marginBottom: 12, background: 'var(--az-warning-bg)', border: '1px solid var(--az-warning)', borderRadius: 4, padding: '10px 12px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <AlertTriangle size={14} style={{ color: 'var(--az-warning)' }} />
                                            <div style={{ fontSize: 12, color: 'var(--az-text)' }}>
                                                Instance is stopped — usage data unavailable
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {metricsStatus === 'insufficient_data' && isRunning && (
                                    <div style={{ marginBottom: 12, background: 'var(--az-warning-bg)', border: '1px solid var(--az-warning)', borderRadius: 4, padding: '10px 12px' }}>
                                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                                            <AlertTriangle size={14} style={{ color: 'var(--az-warning)', marginTop: 1, flexShrink: 0 }} />
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--az-warning)', marginBottom: 4 }}>
                                                    ⚠️ Insufficient data for reliable recommendations
                                                </div>
                                                <div style={{ fontSize: 11, color: 'var(--az-text-2)' }}>
                                                    Instance needs more uptime for accurate analysis.
                                                    {runningHours && metricsWindowDays && (
                                                        <> Running: {runningHours}h / Required: {metricsWindowDays * 24}h</>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                <BAR
                                    label="CPU Utilization"
                                    value={realtimeMetrics?.cpu ?? cpuAvg}
                                    isRunning={isRunning}
                                    showTooltip={false}
                                />
                                <BAR
                                    label="Memory Utilization"
                                    value={realtimeMetrics?.memory ?? memAvg}
                                    isRunning={isRunning}
                                    showTooltip={true}
                                    memoryMetricsSource={realtimeMetrics?.memory === null ? 'agent_required' : memoryMetricsSource}
                                />
                            </div>

                            {/* Missing Metrics Warning */}
                            {isRunning && missingMetrics.length > 0 && (
                                <div style={{ marginBottom: 12, background: 'var(--az-warning-bg)', border: '1px solid var(--az-warning)', borderRadius: 4, padding: '10px 12px' }}>
                                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                                        <AlertTriangle size={14} style={{ color: 'var(--az-warning)', marginTop: 1, flexShrink: 0 }} />
                                        <div style={{ flex: 1 }}>
                                            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--az-warning)', marginBottom: 4 }}>Missing Metrics</div>
                                            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 10, color: 'var(--az-text-2)', lineHeight: 1.5 }}>
                                                {missingMetrics.map((metric, idx) => (
                                                    <li key={idx}>{metric}</li>
                                                ))}
                                            </ul>
                                            <div style={{ marginTop: 6, fontSize: 10, color: 'var(--az-text-3)' }}>
                                                Enable monitoring agents to collect these metrics for better recommendations.
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Cost */}
                            <div style={{ background: '#1B1A19', color: '#fff', borderRadius: 4, padding: '12px 14px' }}>
                                <div style={{ fontSize: 11, color: '#A19F9D', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Current Monthly Cost</div>
                                <div style={{ fontSize: 28, fontWeight: 700 }}>{formatCostWithConversion(displayCurrentCost, resource.currency)}</div>
                                {isStopped && (
                                    <div style={{ fontSize: 11, color: '#A19F9D', marginTop: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                                        <Info size={12} />
                                        <span>Instance stopped - no active charges</span>
                                    </div>
                                )}
                            </div>

                            {/* Pricing Source Transparency */}
                            {!isStopped && (
                                <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--az-surface)', border: '1px solid var(--az-border)', borderRadius: 4, fontSize: 11 }}>
                                    <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <span style={{ fontWeight: 600, color: 'var(--az-text-2)' }}>Price source:</span>
                                        {isLivePricing && (
                                            <span style={{
                                                background: 'var(--az-success-bg)',
                                                color: 'var(--az-success)',
                                                padding: '2px 8px',
                                                borderRadius: 3,
                                                fontSize: 10,
                                                fontWeight: 600,
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                gap: 4
                                            }}>
                                                <CheckCircle size={10} />Live API
                                            </span>
                                        )}
                                        {isCachedPricing && (
                                            <span style={{
                                                background: 'var(--az-blue-light)',
                                                color: 'var(--az-blue)',
                                                padding: '2px 8px',
                                                borderRadius: 3,
                                                fontSize: 10,
                                                fontWeight: 600
                                            }}>
                                                Cached
                                            </span>
                                        )}
                                        {isDatabasePricing && (
                                            <span style={{
                                                background: 'var(--az-warning-bg)',
                                                color: 'var(--az-warning)',
                                                padding: '2px 8px',
                                                borderRadius: 3,
                                                fontSize: 10,
                                                fontWeight: 600
                                            }}>
                                                Database
                                            </span>
                                        )}
                                        {isUnavailablePricing && (
                                            <span style={{
                                                background: '#f3f2f1',
                                                color: 'var(--az-text-3)',
                                                padding: '2px 8px',
                                                borderRadius: 3,
                                                fontSize: 10,
                                                fontWeight: 600
                                            }}>
                                                Unavailable
                                            </span>
                                        )}
                                    </div>
                                    {priceLastUpdated && (
                                        <div style={{ color: 'var(--az-text-2)' }}>
                                            <span style={{ fontWeight: 600 }}>Last updated:</span>{' '}
                                            {getRelativeTime(priceLastUpdated)}
                                        </div>
                                    )}
                                    {fallbackReason && !isLivePricing && (
                                        <div style={{ marginTop: 6, color: 'var(--az-text-3)', fontSize: 10 }}>
                                            <span style={{ fontWeight: 600 }}>Reason:</span> {fallbackReason}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Recommendation */}
                    <div style={{ background: '#fff', border: `1px solid ${isOptimal ? '#107C10' : 'var(--az-blue)'}`, borderRadius: 6, overflow: 'hidden' }}>
                        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--az-border)', background: isOptimal ? 'var(--az-success-bg)' : 'var(--az-blue-light)', display: 'flex', alignItems: 'center', gap: 8 }}>
                            {isOptimal ? <CheckCircle size={15} style={{ color: 'var(--az-success)' }} /> : <TrendingDown size={15} style={{ color: 'var(--az-blue)' }} />}
                            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--az-text)' }}>{isOptimal ? 'Already Optimized' : 'Recommendation'}</span>
                            {coLoading && (
                                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--az-text-3)' }}>Loading AWS Compute Optimizer...</span>
                            )}
                        </div>
                        <div style={{ padding: '16px' }}>
                            {coLoading ? (
                                <div style={{ textAlign: 'center', padding: '24px 16px' }}>
                                    <Loader text="Fetching AWS Compute Optimizer recommendations..." />
                                </div>
                            ) : coError ? (
                                <div style={{ textAlign: 'center', padding: '24px 16px' }}>
                                    <AlertTriangle size={48} style={{ color: 'var(--az-error)', marginBottom: 12 }} />
                                    <h3 style={{ margin: '0 0 8px 0', fontSize: 15, fontWeight: 600, color: 'var(--az-text)' }}>Failed to Load Recommendations</h3>
                                    <p style={{ margin: 0, fontSize: 13, color: 'var(--az-text-2)', marginBottom: 12 }}>
                                        {coError}
                                    </p>
                                    <div style={{ marginTop: 16, padding: '10px 14px', background: 'var(--az-error-bg)', border: '1px solid var(--az-error)', borderRadius: 4, fontSize: 11, color: 'var(--az-text)', textAlign: 'left' }}>
                                        <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--az-error)' }}>Possible reasons:</div>
                                        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 10, lineHeight: 1.5 }}>
                                            <li>AWS Compute Optimizer may not be enabled for your account</li>
                                            <li>Insufficient IAM permissions (requires compute-optimizer:GetEC2InstanceRecommendations)</li>
                                        </ul>
                                    </div>
                                </div>
                            ) : !computeOptimizerRec && resource.provider === 'AWS' ? (
                                <div style={{ textAlign: 'center', padding: '24px 16px' }}>
                                    <Info size={48} style={{ color: 'var(--az-text-3)', marginBottom: 12 }} />
                                    <h3 style={{ margin: '0 0 8px 0', fontSize: 15, fontWeight: 600, color: 'var(--az-text)' }}>No Recommendations Available</h3>
                                    <p style={{ margin: 0, fontSize: 13, color: 'var(--az-text-2)', marginBottom: 12 }}>
                                        AWS Compute Optimizer has not generated recommendations for this instance.
                                    </p>
                                    <div style={{ marginTop: 16, padding: '10px 14px', background: 'var(--az-blue-light)', border: '1px solid var(--az-blue)', borderRadius: 4, fontSize: 11, color: 'var(--az-text)', textAlign: 'left' }}>
                                        <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--az-blue)' }}>Why no recommendations?</div>
                                        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 10, lineHeight: 1.6 }}>
                                            <li>AWS Compute Optimizer requires at least 14 days of metrics data</li>
                                            <li>New instances need more uptime before recommendations can be generated</li>
                                            <li>Check back after your instance has been running for 2+ weeks</li>
                                        </ul>
                                    </div>
                                </div>
                            ) : noGCPRecommendationsAvailable && resource.provider === 'GCP' ? (
                                <div style={{ textAlign: 'center', padding: '24px 16px' }}>
                                    <Info size={48} style={{ color: 'var(--az-text-3)', marginBottom: 12 }} />
                                    <h3 style={{ margin: '0 0 8px 0', fontSize: 15, fontWeight: 600, color: 'var(--az-text)' }}>No Recommendations Available</h3>
                                    <p style={{ margin: 0, fontSize: 13, color: 'var(--az-text-2)', marginBottom: 12 }}>
                                        {resource.recommendation_unavailable_reason || 'GCP Recommender has not generated recommendations for this instance.'}
                                    </p>
                                    <div style={{ marginTop: 16, padding: '10px 14px', background: 'var(--az-blue-light)', border: '1px solid var(--az-blue)', borderRadius: 4, fontSize: 11, color: 'var(--az-text)', textAlign: 'left' }}>
                                        <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--az-blue)' }}>Why no recommendations?</div>
                                        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 10, lineHeight: 1.6 }}>
                                            <li>GCP Recommender requires sufficient usage data to generate recommendations</li>
                                            <li>New instances need more uptime before recommendations can be generated</li>
                                            <li>Instance may already be optimally sized for its workload</li>
                                            <li>Check back after your instance has been running for several days</li>
                                        </ul>
                                    </div>
                                </div>
                            ) : computeOptimizerRec && isOptimal ? (
                                <div>
                                    <div style={{ textAlign: 'center', padding: '24px 16px' }}>
                                        <CheckCircle size={48} style={{ color: 'var(--az-success)', marginBottom: 12 }} />
                                        <h3 style={{ margin: '0 0 8px 0', fontSize: 15, fontWeight: 600, color: 'var(--az-text)' }}>Instance is Optimized</h3>
                                        <p style={{ margin: 0, fontSize: 13, color: 'var(--az-text-2)' }}>AWS Compute Optimizer has determined this instance is optimally sized for its workload.</p>
                                        <div style={{ marginTop: 16, padding: '10px 14px', background: 'var(--az-success-bg)', borderRadius: 4, fontSize: 12, color: 'var(--az-success)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                            <Activity size={13} /> Utilization within optimal range
                                        </div>
                                        {computeOptimizerRec && (
                                            <div style={{ marginTop: 16, padding: '10px 14px', background: 'var(--az-blue-light)', borderRadius: 4, fontSize: 11, color: 'var(--az-text)', textAlign: 'left' }}>
                                                <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--az-blue)' }}>
                                                    <span style={{ background: 'var(--az-blue)', color: '#fff', padding: '2px 6px', borderRadius: 3, fontSize: 9, fontWeight: 600, marginRight: 6 }}>
                                                        AWS Compute Optimizer
                                                    </span>
                                                    Verified Optimization
                                                </div>
                                                <div style={{ fontSize: 10, color: 'var(--az-text-2)' }}>
                                                    Analyzed over the last {computeOptimizerRec.look_back_period_in_days} days. However, there may still be alternative instance types to consider below.
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    {/* Show rightsizing options even for optimized instances */}
                                    {computeOptimizerRec.recommendation_options && computeOptimizerRec.recommendation_options.length > 0 && (
                                        <div style={{ marginTop: 16 }}>
                                            <div style={{ padding: '10px 14px', background: 'var(--az-surface)', borderBottom: '1px solid var(--az-border)', borderRadius: '4px 4px 0 0' }}>
                                                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--az-text)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                                    Alternative Rightsizing Options ({computeOptimizerRec.recommendation_options.length})
                                                </div>
                                            </div>
                                            <div style={{ overflowX: 'auto', border: '1px solid var(--az-border)', borderTop: 'none', borderRadius: '0 0 4px 4px' }}>
                                                <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                                                    <thead>
                                                        <tr style={{ background: 'var(--az-surface)', borderBottom: '1px solid var(--az-border)' }}>
                                                            <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--az-text-2)' }}>Option</th>
                                                            <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--az-text-2)' }}>Instance Type</th>
                                                            <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--az-text-2)' }}>Price (after discounts)</th>
                                                            <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--az-text-2)' }}>On-Demand price</th>
                                                            <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--az-text-2)' }}>Price difference</th>
                                                            <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--az-text-2)' }}>CPU Projected</th>
                                                            <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--az-text-2)' }}>Memory Projected</th>
                                                            <th style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 600, color: 'var(--az-text-2)' }}>Performance Risk</th>
                                                            <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--az-text-2)' }}>Est. Monthly Savings</th>
                                                            <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--az-text-2)' }}>Savings %</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {/* Current Instance Row */}
                                                        <tr style={{ borderBottom: '1px solid var(--az-border)', background: 'var(--az-success-bg)' }}>
                                                            <td style={{ padding: '8px 12px', fontWeight: 600 }}>
                                                                Current
                                                                <span style={{ marginLeft: 6, fontSize: 9, background: 'var(--az-success)', color: '#fff', padding: '2px 4px', borderRadius: 2, fontWeight: 600 }}>
                                                                    OPTIMIZED
                                                                </span>
                                                            </td>
                                                            <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontWeight: 600 }}>{computeOptimizerRec.current_instance_type}</td>
                                                            <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace' }}>
                                                                {computeOptimizerRec.current_hourly_rate ? `$${computeOptimizerRec.current_hourly_rate.toFixed(4)} per hour` : '-'}
                                                            </td>
                                                            <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace' }}>
                                                                {computeOptimizerRec.current_hourly_rate ? `$${computeOptimizerRec.current_hourly_rate.toFixed(4)} per hour` : '-'}
                                                            </td>
                                                            <td style={{ padding: '8px 12px', textAlign: 'right' }}>-</td>
                                                            <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                                                                {computeOptimizerRec.current_cpu_utilization !== null ? `${computeOptimizerRec.current_cpu_utilization.toFixed(1)}%` : '-'}
                                                            </td>
                                                            <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                                                                {computeOptimizerRec.current_memory_utilization !== null ? `${computeOptimizerRec.current_memory_utilization.toFixed(1)}%` : '-'}
                                                            </td>
                                                            <td style={{ padding: '8px 12px', textAlign: 'center' }}>-</td>
                                                            <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }}>
                                                                {computeOptimizerRec.current_monthly_cost ? `${computeOptimizerRec.current_monthly_cost.toFixed(2)}` : '-'}
                                                            </td>
                                                            <td style={{ padding: '8px 12px', textAlign: 'right' }}>-</td>
                                                        </tr>
                                                        {/* Recommendation Options */}
                                                        {computeOptimizerRec.recommendation_options.map((option, idx) => {
                                                            const currentHourly = computeOptimizerRec.current_hourly_rate || 0;
                                                            const optionHourly = option.hourly_rate || 0;
                                                            const priceDiff = currentHourly - optionHourly;

                                                            return (
                                                                <tr key={idx} style={{
                                                                    borderBottom: '1px solid var(--az-border)',
                                                                    background: '#fff'
                                                                }}>
                                                                    <td style={{ padding: '8px 12px' }}>Option {option.option_number}</td>
                                                                    <td style={{ padding: '8px 12px', fontFamily: 'monospace', color: 'var(--az-blue)' }}>
                                                                        {option.instance_type}
                                                                    </td>
                                                                    <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace' }}>
                                                                        {option.hourly_rate ? `$${option.hourly_rate.toFixed(4)} per hour` : '-'}
                                                                    </td>
                                                                    <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace' }}>
                                                                        {option.hourly_rate ? `$${option.hourly_rate.toFixed(4)} per hour` : '-'}
                                                                    </td>
                                                                    <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace', color: priceDiff > 0 ? 'var(--az-success)' : priceDiff < 0 ? 'var(--az-error)' : 'var(--az-text)' }}>
                                                                        {priceDiff !== 0 ? `${priceDiff > 0 ? '-' : '+'}$${Math.abs(priceDiff).toFixed(4)} per hour` : '-'}
                                                                    </td>
                                                                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                                                                        {option.cpu_projected !== null ? `${option.cpu_projected.toFixed(1)}%` : '-'}
                                                                    </td>
                                                                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                                                                        {option.memory_projected !== null ? `${option.memory_projected.toFixed(1)}%` : '-'}
                                                                    </td>
                                                                    <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                                                                        <span style={{
                                                                            padding: '2px 6px',
                                                                            borderRadius: 3,
                                                                            fontSize: 10,
                                                                            fontWeight: 600,
                                                                            background: option.performance_risk <= 1 ? 'var(--az-success-bg)' :
                                                                                option.performance_risk <= 3 ? 'var(--az-warning-bg)' :
                                                                                    'var(--az-error-bg)',
                                                                            color: option.performance_risk <= 1 ? 'var(--az-success)' :
                                                                                option.performance_risk <= 3 ? 'var(--az-warning)' :
                                                                                    'var(--az-error)'
                                                                        }}>
                                                                            {option.performance_risk === 0 ? 'Very Low' :
                                                                                option.performance_risk === 1 ? 'Low' :
                                                                                    option.performance_risk === 2 ? 'Medium' :
                                                                                        option.performance_risk === 3 ? 'High' :
                                                                                            'Very High'}
                                                                        </span>
                                                                    </td>
                                                                    <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: option.estimated_monthly_savings > 0 ? 'var(--az-success)' : 'var(--az-text)' }}>
                                                                        {option.estimated_monthly_savings > 0 ? `$${option.estimated_monthly_savings.toFixed(2)}` : '-'}
                                                                    </td>
                                                                    <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: option.savings_percentage > 0 ? 'var(--az-success)' : 'var(--az-text)' }}>
                                                                        {option.savings_percentage > 0 ? `${option.savings_percentage.toFixed(1)}%` : '-'}
                                                                    </td>
                                                                </tr>
                                                            );
                                                        })}
                                                    </tbody>
                                                </table>
                                            </div>
                                            <div style={{ padding: '8px 14px', background: 'var(--az-surface)', fontSize: 10, color: 'var(--az-text-3)', borderTop: '1px solid var(--az-border)', borderRadius: '0 0 4px 4px' }}>
                                                Lookback period: {computeOptimizerRec.look_back_period_in_days} days
                                                {computeOptimizerRec.last_refresh_timestamp && (
                                                    <span> • Last updated: {new Date(computeOptimizerRec.last_refresh_timestamp).toLocaleDateString()}</span>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ) : isOptimal ? (
                                <div style={{ textAlign: 'center', padding: '24px 16px' }}>
                                    <AlertTriangle size={48} style={{ color: 'var(--az-warning)', marginBottom: 12 }} />
                                    <h3 style={{ margin: '0 0 8px 0', fontSize: 15, fontWeight: 600, color: 'var(--az-text)' }}>Insufficient Confidence</h3>
                                    <p style={{ margin: 0, fontSize: 13, color: 'var(--az-text-2)', marginBottom: 12 }}>
                                        Prediction confidence is too low ({confidencePercent.toFixed(0)}%) to safely recommend changes.
                                    </p>
                                    {confidenceFlag === 'insufficient' && (
                                        <div style={{ marginTop: 16, padding: '10px 14px', background: 'var(--az-warning-bg)', border: '1px solid var(--az-warning)', borderRadius: 4, fontSize: 12, color: 'var(--az-text)', textAlign: 'left' }}>
                                            <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--az-warning)' }}>Why no recommendation?</div>
                                            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, lineHeight: 1.5 }}>
                                                <li>Insufficient usage data collected</li>
                                                <li>Metrics may be incomplete or inconsistent</li>
                                                <li>Instance may need more monitoring time</li>
                                            </ul>
                                        </div>
                                    )}
                                    {missingMetrics.length > 0 && (
                                        <div style={{ marginTop: 12, padding: '10px 14px', background: 'var(--az-blue-light)', border: '1px solid var(--az-blue)', borderRadius: 4, fontSize: 11, color: 'var(--az-text)', textAlign: 'left' }}>
                                            <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--az-blue)' }}>To improve confidence:</div>
                                            <div>Enable missing metrics: {missingMetrics.join(', ')}</div>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                    {/* Stopped instance warning */}
                                    {isStopped && (
                                        <div style={{ background: 'var(--az-warning-bg)', border: '1px solid var(--az-warning)', borderRadius: 4, padding: '10px 14px', display: 'flex', gap: 8 }}>
                                            <AlertTriangle size={14} style={{ color: 'var(--az-warning)', marginTop: 1, flexShrink: 0 }} />
                                            <div style={{ fontSize: 12, color: 'var(--az-text)' }}>
                                                {cpuAvg || memAvg ? (
                                                    <>Instance is currently stopped. Cost and recommendations are based on the last active usage period.</>
                                                ) : (
                                                    <>Start the instance to receive live optimization recommendations.</>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {/* Recommended type - Show Compute Optimizer if available, otherwise ML recommendation */}
                                    <div style={{ background: 'var(--az-blue-light)', border: '1px solid var(--az-blue)', borderRadius: 4, padding: '10px 14px' }}>
                                        <div style={{ fontSize: 11, color: 'var(--az-blue)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
                                            Recommended Type
                                            {computeOptimizerRec && (
                                                <span style={{ marginLeft: 8, fontSize: 9, background: 'var(--az-blue)', color: '#fff', padding: '2px 6px', borderRadius: 3, fontWeight: 600 }}>
                                                    AWS Compute Optimizer
                                                </span>
                                            )}
                                        </div>
                                        <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'monospace', color: 'var(--az-blue)' }}>
                                            {computeOptimizerRec?.recommended_instance_type || resource.recommendedType || resource.recommended_instance || 'N/A'}
                                        </div>
                                        {computeOptimizerRec && (
                                            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--az-text-2)' }}>
                                                <div style={{ marginBottom: 4 }}>
                                                    <span style={{ fontWeight: 600 }}>Finding:</span>{' '}
                                                    <span style={{
                                                        padding: '2px 6px',
                                                        borderRadius: 3,
                                                        fontSize: 10,
                                                        fontWeight: 600,
                                                        background: computeOptimizerRec.finding === 'Overprovisioned' ? 'var(--az-warning-bg)' :
                                                            computeOptimizerRec.finding === 'Underprovisioned' ? 'var(--az-error-bg)' :
                                                                'var(--az-success-bg)',
                                                        color: computeOptimizerRec.finding === 'Overprovisioned' ? 'var(--az-warning)' :
                                                            computeOptimizerRec.finding === 'Underprovisioned' ? 'var(--az-error)' :
                                                                'var(--az-success)'
                                                    }}>
                                                        {computeOptimizerRec.finding}
                                                    </span>
                                                </div>
                                                {computeOptimizerRec.finding_reasons && computeOptimizerRec.finding_reasons.length > 0 && (
                                                    <div style={{ marginTop: 6 }}>
                                                        <span style={{ fontWeight: 600 }}>Reasons:</span>
                                                        <ul style={{ margin: '4px 0 0 0', paddingLeft: 16, fontSize: 10 }}>
                                                            {computeOptimizerRec.finding_reasons.map((reason, idx) => (
                                                                <li key={idx}>{reason}</li>
                                                            ))}
                                                        </ul>
                                                    </div>
                                                )}
                                                {computeOptimizerRec.performance_risk !== null && computeOptimizerRec.performance_risk !== undefined && (
                                                    <div style={{ marginTop: 6 }}>
                                                        <span style={{ fontWeight: 600 }}>Performance Risk:</span>{' '}
                                                        <span style={{
                                                            padding: '2px 6px',
                                                            borderRadius: 3,
                                                            fontSize: 10,
                                                            fontWeight: 600,
                                                            background: computeOptimizerRec.performance_risk <= 1 ? 'var(--az-success-bg)' :
                                                                computeOptimizerRec.performance_risk <= 3 ? 'var(--az-warning-bg)' :
                                                                    'var(--az-error-bg)',
                                                            color: computeOptimizerRec.performance_risk <= 1 ? 'var(--az-success)' :
                                                                computeOptimizerRec.performance_risk <= 3 ? 'var(--az-warning)' :
                                                                    'var(--az-error)'
                                                        }}>
                                                            {computeOptimizerRec.performance_risk === 0 ? 'Very Low' :
                                                                computeOptimizerRec.performance_risk === 1 ? 'Low' :
                                                                    computeOptimizerRec.performance_risk === 2 ? 'Medium' :
                                                                        computeOptimizerRec.performance_risk === 3 ? 'High' :
                                                                            'Very High'}
                                                        </span>
                                                    </div>
                                                )}
                                                {(computeOptimizerRec.cpu_projected_utilization !== null || computeOptimizerRec.memory_projected_utilization !== null) && (
                                                    <div style={{ marginTop: 6 }}>
                                                        <span style={{ fontWeight: 600 }}>Projected Utilization:</span>
                                                        {computeOptimizerRec.cpu_projected_utilization !== null && (
                                                            <span> CPU: {computeOptimizerRec.cpu_projected_utilization.toFixed(1)}%</span>
                                                        )}
                                                        {computeOptimizerRec.memory_projected_utilization !== null && (
                                                            <span> | Memory: {computeOptimizerRec.memory_projected_utilization.toFixed(1)}%</span>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>

                                    {/* All Recommendation Options Table - Like AWS Console */}
                                    {computeOptimizerRec && computeOptimizerRec.recommendation_options && computeOptimizerRec.recommendation_options.length > 0 && (
                                        <div style={{ background: '#fff', border: '1px solid var(--az-border)', borderRadius: 4, overflow: 'hidden' }}>
                                            <div style={{ padding: '10px 14px', background: 'var(--az-surface)', borderBottom: '1px solid var(--az-border)' }}>
                                                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--az-text)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                                    Rightsizing Options ({computeOptimizerRec.recommendation_options.length})
                                                </div>
                                            </div>
                                            <div style={{ overflowX: 'auto' }}>
                                                <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                                                    <thead>
                                                        <tr style={{ background: 'var(--az-surface)', borderBottom: '1px solid var(--az-border)' }}>
                                                            <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--az-text-2)' }}>Option</th>
                                                            <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--az-text-2)' }}>Instance Type</th>
                                                            <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--az-text-2)' }}>Price (after discounts)</th>
                                                            <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--az-text-2)' }}>On-Demand price</th>
                                                            <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--az-text-2)' }}>Price difference</th>
                                                            <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--az-text-2)' }}>CPU Projected</th>
                                                            <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--az-text-2)' }}>Memory Projected</th>
                                                            <th style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 600, color: 'var(--az-text-2)' }}>Performance Risk</th>
                                                            <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--az-text-2)' }}>Est. Monthly Savings</th>
                                                            <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--az-text-2)' }}>Savings %</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {/* Current Instance Row */}
                                                        <tr style={{ borderBottom: '1px solid var(--az-border)', background: 'var(--az-bg)' }}>
                                                            <td style={{ padding: '8px 12px', fontWeight: 600 }}>Current</td>
                                                            <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontWeight: 600 }}>{computeOptimizerRec.current_instance_type}</td>
                                                            <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace' }}>
                                                                {computeOptimizerRec.current_hourly_rate ? `$${computeOptimizerRec.current_hourly_rate.toFixed(4)} per hour` : '-'}
                                                            </td>
                                                            <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace' }}>
                                                                {computeOptimizerRec.current_hourly_rate ? `$${computeOptimizerRec.current_hourly_rate.toFixed(4)} per hour` : '-'}
                                                            </td>
                                                            <td style={{ padding: '8px 12px', textAlign: 'right' }}>-</td>
                                                            <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                                                                {computeOptimizerRec.current_cpu_utilization !== null ? `${computeOptimizerRec.current_cpu_utilization.toFixed(1)}%` : '-'}
                                                            </td>
                                                            <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                                                                {computeOptimizerRec.current_memory_utilization !== null ? `${computeOptimizerRec.current_memory_utilization.toFixed(1)}%` : '-'}
                                                            </td>
                                                            <td style={{ padding: '8px 12px', textAlign: 'center' }}>-</td>
                                                            <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }}>
                                                                {computeOptimizerRec.current_monthly_cost ? `${computeOptimizerRec.current_monthly_cost.toFixed(2)}` : '-'}
                                                            </td>
                                                            <td style={{ padding: '8px 12px', textAlign: 'right' }}>-</td>
                                                        </tr>
                                                        {/* Recommendation Options */}
                                                        {computeOptimizerRec.recommendation_options.map((option, idx) => {
                                                            const currentHourly = computeOptimizerRec.current_hourly_rate || 0;
                                                            const optionHourly = option.hourly_rate || 0;
                                                            const priceDiff = currentHourly - optionHourly;

                                                            return (
                                                                <tr key={idx} style={{
                                                                    borderBottom: '1px solid var(--az-border)',
                                                                    background: idx === 0 ? 'var(--az-blue-light)' : '#fff'
                                                                }}>
                                                                    <td style={{ padding: '8px 12px', fontWeight: idx === 0 ? 600 : 400 }}>
                                                                        Option {option.option_number}
                                                                        {idx === 0 && (
                                                                            <span style={{ marginLeft: 6, fontSize: 9, background: 'var(--az-blue)', color: '#fff', padding: '2px 4px', borderRadius: 2, fontWeight: 600 }}>
                                                                                RECOMMENDED
                                                                            </span>
                                                                        )}
                                                                    </td>
                                                                    <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontWeight: idx === 0 ? 600 : 400, color: 'var(--az-blue)' }}>
                                                                        {option.instance_type}
                                                                    </td>
                                                                    <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace' }}>
                                                                        {option.hourly_rate ? `${option.hourly_rate.toFixed(4)} per hour` : '-'}
                                                                    </td>
                                                                    <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace' }}>
                                                                        {option.hourly_rate ? `${option.hourly_rate.toFixed(4)} per hour` : '-'}
                                                                    </td>
                                                                    <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace', color: priceDiff > 0 ? 'var(--az-success)' : priceDiff < 0 ? 'var(--az-error)' : 'var(--az-text)' }}>
                                                                        {priceDiff !== 0 ? `${priceDiff > 0 ? '-' : '+'}${Math.abs(priceDiff).toFixed(4)} per hour` : '-'}
                                                                    </td>
                                                                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                                                                        {option.cpu_projected !== null ? `${option.cpu_projected.toFixed(1)}%` : '-'}
                                                                    </td>
                                                                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                                                                        {option.memory_projected !== null ? `${option.memory_projected.toFixed(1)}%` : '-'}
                                                                    </td>
                                                                    <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                                                                        <span style={{
                                                                            padding: '2px 6px',
                                                                            borderRadius: 3,
                                                                            fontSize: 10,
                                                                            fontWeight: 600,
                                                                            background: option.performance_risk <= 1 ? 'var(--az-success-bg)' :
                                                                                option.performance_risk <= 3 ? 'var(--az-warning-bg)' :
                                                                                    'var(--az-error-bg)',
                                                                            color: option.performance_risk <= 1 ? 'var(--az-success)' :
                                                                                option.performance_risk <= 3 ? 'var(--az-warning)' :
                                                                                    'var(--az-error)'
                                                                        }}>
                                                                            {option.performance_risk === 0 ? 'Very Low' :
                                                                                option.performance_risk === 1 ? 'Low' :
                                                                                    option.performance_risk === 2 ? 'Medium' :
                                                                                        option.performance_risk === 3 ? 'High' :
                                                                                            'Very High'}
                                                                        </span>
                                                                    </td>
                                                                    <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: option.estimated_monthly_savings > 0 ? 'var(--az-success)' : 'var(--az-text)' }}>
                                                                        {option.estimated_monthly_savings > 0 ? `$${option.estimated_monthly_savings.toFixed(2)}` : '-'}
                                                                    </td>
                                                                    <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: option.savings_percentage > 0 ? 'var(--az-success)' : 'var(--az-text)' }}>
                                                                        {option.savings_percentage > 0 ? `${option.savings_percentage.toFixed(1)}%` : '-'}
                                                                    </td>
                                                                </tr>
                                                            );
                                                        })}
                                                    </tbody>
                                                </table>
                                            </div>
                                            <div style={{ padding: '8px 14px', background: 'var(--az-surface)', fontSize: 10, color: 'var(--az-text-3)', borderTop: '1px solid var(--az-border)' }}>
                                                Lookback period: {computeOptimizerRec.look_back_period_in_days} days
                                                {computeOptimizerRec.last_refresh_timestamp && (
                                                    <span> • Last updated: {new Date(computeOptimizerRec.last_refresh_timestamp).toLocaleDateString()}</span>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {/* Architecture & Compatibility Confirmation */}
                                    <div style={{ background: 'var(--az-success-bg)', border: '1px solid var(--az-success)', borderRadius: 4, padding: '10px 14px' }}>
                                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--az-success)', marginBottom: 6 }}>Compatibility Check</div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--az-text)' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                <CheckCircle size={12} style={{ color: 'var(--az-success)' }} />
                                                <span>Same architecture ({architecture})</span>
                                            </div>
                                            {instanceFamily && (
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                    <CheckCircle size={12} style={{ color: 'var(--az-success)' }} />
                                                    <span>Same instance family category</span>
                                                </div>
                                            )}
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                {isAvailableInRegion ? (
                                                    <>
                                                        <CheckCircle size={12} style={{ color: 'var(--az-success)' }} />
                                                        <span>Available in {resource.region}</span>
                                                    </>
                                                ) : (
                                                    <>
                                                        <AlertTriangle size={12} style={{ color: 'var(--az-error)' }} />
                                                        <span style={{ color: 'var(--az-error)' }}>Not available in {resource.region}</span>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Specs grid */}
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                                        {[['vCPU', resource.recommendedVcpu || resource.vCpu || resource.vcpu || 'N/A', Cpu], ['Memory', `${resource.recommendedMemory || resource.memoryGb || resource.memory || 'N/A'} GB`, HardDrive]].map(([l, v, Icon]) => (
                                            <div key={l} style={{ border: '1px solid var(--az-blue-mid)', borderRadius: 4, padding: '8px 12px', display: 'flex', gap: 8, alignItems: 'center' }}>
                                                <Icon size={14} style={{ color: 'var(--az-blue)' }} />
                                                <div>
                                                    <div style={{ fontSize: 11, color: 'var(--az-text-3)' }}>{l}</div>
                                                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--az-blue)' }}>{v}</div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>

                                    {/* Savings card with expandable breakdown */}
                                    <div style={{ background: 'var(--az-success)', color: '#fff', borderRadius: 4, padding: '14px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                                            <DollarSign size={14} />
                                            <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Estimated Monthly Savings</span>
                                            {computeOptimizerRec && (
                                                <span style={{ marginLeft: 'auto', fontSize: 9, background: 'rgba(255,255,255,0.3)', padding: '2px 6px', borderRadius: 3, fontWeight: 600 }}>
                                                    AWS CO
                                                </span>
                                            )}
                                        </div>
                                        <div style={{ fontSize: 32, fontWeight: 700, lineHeight: 1 }}>${savings.toFixed(2)}</div>
                                        <div style={{ fontSize: 12, marginTop: 4, color: 'rgba(255,255,255,0.8)' }}>Annual: ${(savings * 12).toFixed(2)}</div>

                                        {/* Expandable breakdown */}
                                        <button
                                            onClick={() => setSavingsExpanded(!savingsExpanded)}
                                            style={{
                                                marginTop: 8,
                                                background: 'rgba(255,255,255,0.2)',
                                                border: 'none',
                                                color: '#fff',
                                                padding: '6px 10px',
                                                borderRadius: 3,
                                                fontSize: 11,
                                                cursor: 'pointer',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: 4,
                                                fontFamily: 'inherit'
                                            }}
                                        >
                                            {savingsExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                                            {savingsExpanded ? 'Hide' : 'Show'} breakdown
                                        </button>

                                        {savingsExpanded && (
                                            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.3)', fontSize: 11 }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                                    <span>Current cost:</span>
                                                    <span style={{ fontWeight: 600 }}>{formatCostWithConversion(displayCurrentCost, resource.currency)} / month</span>
                                                </div>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                                    <span>Recommended cost:</span>
                                                    <span style={{ fontWeight: 600 }}>{formatCostWithConversion(recommendedCost, resource.currency)} / month</span>
                                                </div>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.3)' }}>
                                                    <span style={{ fontWeight: 600 }}>Estimated savings:</span>
                                                    <span style={{ fontWeight: 700 }}>{formatCostWithConversion(savings, resource.currency)} / month</span>
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    {/* Pricing Source Transparency for recommendations */}
                                    {!isStopped && (
                                        <div style={{ padding: '10px 12px', background: 'var(--az-surface)', border: '1px solid var(--az-border)', borderRadius: 4, fontSize: 11 }}>
                                            <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                                                <span style={{ fontWeight: 600, color: 'var(--az-text-2)' }}>Price source:</span>
                                                {isLivePricing && (
                                                    <span style={{
                                                        background: 'var(--az-success-bg)',
                                                        color: 'var(--az-success)',
                                                        padding: '2px 8px',
                                                        borderRadius: 3,
                                                        fontSize: 10,
                                                        fontWeight: 600,
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        gap: 4
                                                    }}>
                                                        <CheckCircle size={10} />Live API
                                                    </span>
                                                )}
                                                {isCachedPricing && (
                                                    <span style={{
                                                        background: 'var(--az-blue-light)',
                                                        color: 'var(--az-blue)',
                                                        padding: '2px 8px',
                                                        borderRadius: 3,
                                                        fontSize: 10,
                                                        fontWeight: 600
                                                    }}>
                                                        Cached
                                                    </span>
                                                )}
                                                {isDatabasePricing && (
                                                    <span style={{
                                                        background: 'var(--az-warning-bg)',
                                                        color: 'var(--az-warning)',
                                                        padding: '2px 8px',
                                                        borderRadius: 3,
                                                        fontSize: 10,
                                                        fontWeight: 600
                                                    }}>
                                                        Database
                                                    </span>
                                                )}
                                                {isUnavailablePricing && (
                                                    <span style={{
                                                        background: '#f3f2f1',
                                                        color: 'var(--az-text-3)',
                                                        padding: '2px 8px',
                                                        borderRadius: 3,
                                                        fontSize: 10,
                                                        fontWeight: 600
                                                    }}>
                                                        Unavailable
                                                    </span>
                                                )}
                                            </div>
                                            {priceLastUpdated && (
                                                <div style={{ color: 'var(--az-text-2)' }}>
                                                    <span style={{ fontWeight: 600 }}>Last updated:</span>{' '}
                                                    {getRelativeTime(priceLastUpdated)}
                                                </div>
                                            )}
                                            {fallbackReason && !isLivePricing && (
                                                <div style={{ marginTop: 6, color: 'var(--az-text-3)', fontSize: 10 }}>
                                                    <span style={{ fontWeight: 600 }}>Reason:</span> {fallbackReason}
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {/* Reason */}
                                    <div style={{ background: 'var(--az-blue-light)', border: '1px solid var(--az-blue-mid)', borderRadius: 4, padding: '10px 14px', display: 'flex', gap: 8 }}>
                                        <AlertTriangle size={14} style={{ color: 'var(--az-blue)', marginTop: 1, flexShrink: 0 }} />
                                        <div>
                                            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--az-blue)', marginBottom: 2 }}>Why this recommendation?</div>
                                            <div style={{ fontSize: 12, color: 'var(--az-text-2)' }}>
                                                {computeOptimizerRec?.recommendation || resource.reason || 'Based on current usage patterns, downsizing will maintain performance while reducing costs.'}
                                            </div>
                                        </div>
                                    </div>

                                    {/* ML Prediction Confidence */}
                                    {confidencePercent > 0 && (
                                        <div style={{
                                            background: isHighConfidence ? 'var(--az-success-bg)' : 'var(--az-warning-bg)',
                                            border: `1px solid ${isHighConfidence ? 'var(--az-success)' : 'var(--az-warning)'}`,
                                            borderRadius: 4,
                                            padding: '10px 14px',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 8
                                        }}>
                                            {isHighConfidence ? (
                                                <CheckCircle size={14} style={{ color: 'var(--az-success)', flexShrink: 0 }} />
                                            ) : (
                                                <AlertTriangle size={14} style={{ color: 'var(--az-warning)', flexShrink: 0 }} />
                                            )}
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--az-text)', marginBottom: 2 }}>
                                                    Prediction confidence: {confidencePercent.toFixed(0)}%
                                                    {isHighConfidence && ' ✅'}
                                                    {!isHighConfidence && !isLowConfidence && ' ⚠️ Low confidence'}
                                                </div>
                                                {isLowConfidence && (
                                                    <div style={{ fontSize: 11, color: 'var(--az-text-2)' }}>
                                                        Insufficient confidence to safely recommend changes.
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </AnimatedSection>
        </div>
    );
}

