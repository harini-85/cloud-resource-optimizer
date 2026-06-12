import React from 'react';
import PropTypes from 'prop-types';
import ConfidenceIndicator from './ConfidenceIndicator';
import AnomalyAlert from './AnomalyAlert';
import Badge from './Badge';

/**
 * RecommendationCard Component
 * Displays ML-based instance recommendations with confidence scores, cost breakdown, and anomaly alerts
 * 
 * Features:
 * - Color-coded recommendation badges (Optimal, Oversized, Undersized, Zombie)
 * - Confidence score visualization
 * - Low confidence warnings
 * - Current and recommended instance types
 * - Cost breakdown with savings
 * - Data quality indicators
 * - Anomaly alerts
 */

const RecommendationCard = ({ recommendation }) => {
    if (!recommendation) {
        return (
            <div className="bg-white rounded-lg shadow p-6">
                <p className="text-gray-500">No recommendation available</p>
            </div>
        );
    }

    const {
        prediction,
        confidence,
        confidence_flag,
        instance_type,
        recommended_type,
        recommendedType,
        current_cost_per_month,
        currentCostPerMonth,
        optimized_cost_per_month,
        optimizedCostPerMonth,
        savings,
        monthly_savings,
        data_quality,
        data_days,
        granularity,
        anomaly_flag,
        anomaly_message,
        recommendation_text,
        ml_recommendation_text,
        performance_risk,
        cost_impact
    } = recommendation;

    // Normalize field names (handle both snake_case and camelCase)
    const recommendedInstance = recommended_type || recommendedType;
    const currentCost = current_cost_per_month || currentCostPerMonth;
    const optimizedCost = optimized_cost_per_month || optimizedCostPerMonth;
    const savingsAmount = savings || monthly_savings;
    const recommendationText = recommendation_text || ml_recommendation_text;

    // Determine badge color based on prediction type
    const getBadgeColor = (predictionType) => {
        switch (predictionType) {
            case 'Optimal':
                return 'green';
            case 'Oversized':
                return 'blue';
            case 'Undersized':
                return 'orange';
            case 'Zombie':
                return 'red';
            case 'Insufficient Data':
                return 'gray';
            default:
                return 'gray';
        }
    };

    // Format cost values
    const formatCost = (cost) => {
        if (cost === null || cost === undefined || cost === 'N/A') {
            return 'N/A';
        }
        return `$${parseFloat(cost).toFixed(2)}`;
    };

    // Format savings
    const formatSavings = (savingsValue) => {
        if (savingsValue === null || savingsValue === undefined || savingsValue === 'N/A') {
            return 'N/A';
        }
        if (typeof savingsValue === 'number') {
            return `$${parseFloat(savingsValue).toFixed(2)}`;
        }
        return savingsValue;
    };

    // Check if confidence is low
    const isLowConfidence = confidence < 0.75;
    const isInsufficientData = confidence_flag === 'insufficient' || prediction === 'Insufficient Data';

    return (
        <div className="bg-white rounded-lg shadow-md p-6 space-y-4">
            {/* Header with Recommendation Badge */}
            <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                    <Badge color={getBadgeColor(prediction)} size="lg">
                        {prediction}
                    </Badge>
                    {prediction === 'Zombie' && (
                        <span className="text-sm text-red-600 font-semibold">
                            ⚠️ Termination Recommended
                        </span>
                    )}
                </div>

                {/* Confidence Indicator */}
                {!isInsufficientData && (
                    <ConfidenceIndicator
                        confidence={confidence}
                        dataDays={data_days}
                        granularity={granularity}
                    />
                )}
            </div>

            {/* Low Confidence Warning */}
            {isLowConfidence && !isInsufficientData && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3">
                    <div className="flex items-start">
                        <span className="text-yellow-600 mr-2">⚠️</span>
                        <div>
                            <p className="text-sm font-medium text-yellow-800">Low Confidence Warning</p>
                            <p className="text-xs text-yellow-700 mt-1">
                                This recommendation has lower confidence ({Math.round(confidence * 100)}%).
                                Consider gathering more data or reviewing manually.
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* Insufficient Data Warning */}
            {isInsufficientData && (
                <div className="bg-gray-50 border border-gray-200 rounded-md p-3">
                    <div className="flex items-start">
                        <span className="text-gray-600 mr-2">ℹ️</span>
                        <div>
                            <p className="text-sm font-medium text-gray-800">Insufficient Data</p>
                            <p className="text-xs text-gray-700 mt-1">
                                Not enough metrics available to generate a reliable recommendation.
                                Ensure CloudWatch metrics are enabled and collecting data.
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* Anomaly Alerts */}
            {anomaly_flag && anomaly_flag !== 'none' && (
                <AnomalyAlert type={anomaly_flag} message={anomaly_message} />
            )}

            {/* Instance Details */}
            {!isInsufficientData && (
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <p className="text-sm text-gray-600">Current Instance</p>
                        <p className="text-lg font-semibold text-gray-900">{instance_type}</p>
                    </div>
                    {recommendedInstance && recommendedInstance !== 'TERMINATE' && (
                        <div>
                            <p className="text-sm text-gray-600">Recommended Instance</p>
                            <p className="text-lg font-semibold text-blue-600">{recommendedInstance}</p>
                        </div>
                    )}
                    {recommendedInstance === 'TERMINATE' && (
                        <div>
                            <p className="text-sm text-gray-600">Recommended Action</p>
                            <p className="text-lg font-semibold text-red-600">TERMINATE</p>
                        </div>
                    )}
                </div>
            )}

            {/* Cost Breakdown */}
            {!isInsufficientData && currentCost !== null && currentCost !== undefined && (
                <div className="border-t pt-4">
                    <h4 className="text-sm font-semibold text-gray-700 mb-3">Cost Analysis</h4>
                    <div className="grid grid-cols-3 gap-4">
                        <div>
                            <p className="text-xs text-gray-600">Current Cost</p>
                            <p className="text-lg font-semibold text-gray-900">{formatCost(currentCost)}/mo</p>
                        </div>
                        {optimizedCost !== null && optimizedCost !== undefined && (
                            <div>
                                <p className="text-xs text-gray-600">Optimized Cost</p>
                                <p className="text-lg font-semibold text-blue-600">{formatCost(optimizedCost)}/mo</p>
                            </div>
                        )}
                        {savingsAmount !== null && savingsAmount !== undefined && (
                            <div>
                                <p className="text-xs text-gray-600">
                                    {prediction === 'Undersized' ? 'Cost Increase' : 'Monthly Savings'}
                                </p>
                                <p className={`text-lg font-semibold ${prediction === 'Undersized' ? 'text-orange-600' : 'text-green-600'
                                    }`}>
                                    {formatSavings(savingsAmount)}
                                    {prediction === 'Undersized' && cost_impact === 'INCREASE' && ' ⬆️'}
                                </p>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Performance Risk (for Undersized instances) */}
            {performance_risk && performance_risk === 'HIGH' && (
                <div className="bg-orange-50 border border-orange-200 rounded-md p-3">
                    <div className="flex items-start">
                        <span className="text-orange-600 mr-2">⚡</span>
                        <div>
                            <p className="text-sm font-medium text-orange-800">Performance Risk</p>
                            <p className="text-xs text-orange-700 mt-1">
                                This instance is undersized and may experience performance degradation or outages.
                                Upsizing is recommended to prevent service disruption.
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* Recommendation Text */}
            {recommendationText && (
                <div className="border-t pt-4">
                    <p className="text-sm text-gray-700">{recommendationText}</p>
                </div>
            )}

            {/* Data Quality Indicator */}
            {data_quality && (
                <div className="flex items-center justify-between text-xs text-gray-500 border-t pt-3">
                    <div className="flex items-center space-x-4">
                        <span>
                            Data Quality:
                            <span className={`ml-1 font-semibold ${data_quality === 'high' ? 'text-green-600' :
                                    data_quality === 'medium' ? 'text-yellow-600' :
                                        'text-red-600'
                                }`}>
                                {data_quality.toUpperCase()}
                            </span>
                        </span>
                        {data_days && (
                            <span>
                                Data Period: <span className="font-semibold">{data_days} days</span>
                            </span>
                        )}
                        {granularity && (
                            <span>
                                Granularity: <span className="font-semibold">{granularity}</span>
                            </span>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

RecommendationCard.propTypes = {
    recommendation: PropTypes.shape({
        prediction: PropTypes.string,
        confidence: PropTypes.number,
        confidence_flag: PropTypes.string,
        instance_type: PropTypes.string,
        recommended_type: PropTypes.string,
        recommendedType: PropTypes.string,
        current_cost_per_month: PropTypes.number,
        currentCostPerMonth: PropTypes.number,
        optimized_cost_per_month: PropTypes.number,
        optimizedCostPerMonth: PropTypes.number,
        savings: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
        monthly_savings: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
        data_quality: PropTypes.string,
        data_days: PropTypes.number,
        granularity: PropTypes.string,
        anomaly_flag: PropTypes.string,
        anomaly_message: PropTypes.string,
        recommendation_text: PropTypes.string,
        ml_recommendation_text: PropTypes.string,
        performance_risk: PropTypes.string,
        cost_impact: PropTypes.string
    })
};

export default RecommendationCard;
