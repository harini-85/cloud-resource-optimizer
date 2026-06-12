import React from 'react';
import PropTypes from 'prop-types';
import { AlertTriangle, Flame, Zap, Activity, Skull } from 'lucide-react';

/**
 * AnomalyAlert Component
 * Displays anomaly warnings with appropriate severity levels and icons
 * 
 * Anomaly Types:
 * - zombie_candidate: Instance has been idle for extended period (red, critical)
 * - sustained_overload: Instance is critically overloaded (red, critical)
 * - memory_crisis: Severe memory pressure detected (red, urgent)
 * - spike_contamination: Data quality warning due to extreme spikes (orange, warning)
 * 
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
 */

const AnomalyAlert = ({ type, message }) => {
    if (!type || type === 'none') {
        return null;
    }

    // Define anomaly styles with icons and colors
    const anomalyConfig = {
        zombie_candidate: {
            color: 'red',
            bgColor: 'bg-red-50',
            borderColor: 'border-red-200',
            textColor: 'text-red-800',
            icon: Skull,
            iconColor: 'text-red-600',
            title: 'Zombie Instance Detected',
            severity: 'critical',
            defaultMessage: 'This instance has been idle for an extended period. Consider terminating to eliminate costs.'
        },
        sustained_overload: {
            color: 'red',
            bgColor: 'bg-red-50',
            borderColor: 'border-red-200',
            textColor: 'text-red-800',
            icon: Flame,
            iconColor: 'text-red-600',
            title: 'Critical Overload',
            severity: 'critical',
            defaultMessage: 'This instance is critically overloaded. Investigate root cause before making changes.'
        },
        memory_crisis: {
            color: 'red',
            bgColor: 'bg-red-50',
            borderColor: 'border-red-200',
            textColor: 'text-red-800',
            icon: Zap,
            iconColor: 'text-red-600',
            title: 'Memory Crisis',
            severity: 'urgent',
            defaultMessage: 'Severe memory pressure detected. Immediate upsizing recommended to prevent outage.'
        },
        spike_contamination: {
            color: 'orange',
            bgColor: 'bg-orange-50',
            borderColor: 'border-orange-200',
            textColor: 'text-orange-800',
            icon: Activity,
            iconColor: 'text-orange-600',
            title: 'Data Quality Warning',
            severity: 'warning',
            defaultMessage: 'Extreme spikes detected in metrics. Recommendation confidence may be affected.'
        }
    };

    const config = anomalyConfig[type];

    if (!config) {
        // Unknown anomaly type - show generic warning
        return (
            <div className="bg-yellow-50 border border-yellow-200 rounded-md p-4">
                <div className="flex items-start">
                    <AlertTriangle className="text-yellow-600 mr-3 mt-0.5" size={20} />
                    <div className="flex-1">
                        <h4 className="text-sm font-semibold text-yellow-800">Anomaly Detected</h4>
                        <p className="text-sm text-yellow-700 mt-1">
                            {message || 'An anomaly was detected in the instance metrics.'}
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    const Icon = config.icon;

    return (
        <div className={`${config.bgColor} border ${config.borderColor} rounded-md p-4`}>
            <div className="flex items-start">
                {/* Icon */}
                <Icon className={`${config.iconColor} mr-3 mt-0.5 flex-shrink-0`} size={20} />

                {/* Content */}
                <div className="flex-1">
                    {/* Title with Severity Badge */}
                    <div className="flex items-center space-x-2 mb-1">
                        <h4 className={`text-sm font-semibold ${config.textColor}`}>
                            {config.title}
                        </h4>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${config.severity === 'critical' ? 'bg-red-100 text-red-700' :
                                config.severity === 'urgent' ? 'bg-red-100 text-red-700' :
                                    'bg-orange-100 text-orange-700'
                            }`}>
                            {config.severity.toUpperCase()}
                        </span>
                    </div>

                    {/* Message */}
                    <p className={`text-sm ${config.textColor} mt-1`}>
                        {message || config.defaultMessage}
                    </p>

                    {/* Additional context based on anomaly type */}
                    {type === 'zombie_candidate' && (
                        <div className="mt-3 pt-3 border-t border-red-200">
                            <p className="text-xs text-red-700 font-medium">
                                💡 Recommended Action: Terminate this instance to save 100% of costs
                            </p>
                        </div>
                    )}

                    {type === 'sustained_overload' && (
                        <div className="mt-3 pt-3 border-t border-red-200">
                            <p className="text-xs text-red-700 font-medium">
                                ⚠️ Action Required: Investigate workload patterns and resource bottlenecks before resizing
                            </p>
                        </div>
                    )}

                    {type === 'memory_crisis' && (
                        <div className="mt-3 pt-3 border-t border-red-200">
                            <p className="text-xs text-red-700 font-medium">
                                🚨 Urgent: Upsize immediately to prevent service disruption
                            </p>
                        </div>
                    )}

                    {type === 'spike_contamination' && (
                        <div className="mt-3 pt-3 border-t border-orange-200">
                            <p className="text-xs text-orange-700 font-medium">
                                ℹ️ Note: Consider collecting more data or investigating spike causes for better recommendations
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

AnomalyAlert.propTypes = {
    type: PropTypes.oneOf([
        'zombie_candidate',
        'sustained_overload',
        'memory_crisis',
        'spike_contamination',
        'none'
    ]),
    message: PropTypes.string
};

AnomalyAlert.defaultProps = {
    type: 'none',
    message: null
};

export default AnomalyAlert;
