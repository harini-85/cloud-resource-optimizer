import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import Badge from './Badge';

/**
 * ConfidenceIndicator Component
 * 
 * Displays confidence score as percentage with color coding, tooltip, and data quality information.
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */
export default function ConfidenceIndicator({
    confidence,
    dataDays = null,
    granularity = null,
    showLabel = true,
    size = 'md'
}) {
    const [showTooltip, setShowTooltip] = useState(false);

    // Requirement 7.4: Hide recommendation if confidence < 0.50
    if (confidence === null || confidence === undefined || confidence < 0.50) {
        return null;
    }

    const conf = parseFloat(confidence) || 0;

    let level, color, bg, icon, label, showWarning = false;

    // Requirement 7.2: High confidence (≥ 0.75) - green indicator
    if (conf >= 0.75) {
        level = 'high';
        color = 'var(--az-success)';
        bg = 'var(--az-success-bg)';
        icon = CheckCircle2;
        label = 'High Confidence';
        showWarning = false;
    }
    // Requirement 7.3: Medium confidence (≥ 0.50 and < 0.75) - yellow indicator
    else if (conf >= 0.50) {
        level = 'medium';
        color = '#8A3707';
        bg = 'var(--az-warning-bg)';
        icon = AlertCircle;
        label = 'Medium Confidence';
        showWarning = true;
    }

    const Icon = icon;
    // Requirement 7.1: Display confidence as percentage (0-100%)
    const percentage = Math.round(conf * 100);

    const sizeStyles = {
        sm: { fontSize: 11, iconSize: 12, barHeight: 4 },
        md: { fontSize: 12, iconSize: 14, barHeight: 6 },
        lg: { fontSize: 13, iconSize: 16, barHeight: 8 },
    };

    const { fontSize, iconSize, barHeight } = sizeStyles[size] || sizeStyles.md;

    // Requirement 7.5: Tooltip explaining confidence calculation
    const tooltipContent = (
        <div style={{
            position: 'absolute',
            bottom: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginBottom: '8px',
            padding: '8px 12px',
            background: '#1f2937',
            color: 'white',
            borderRadius: '6px',
            fontSize: '12px',
            whiteSpace: 'nowrap',
            zIndex: 1000,
            boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)'
        }}>
            <div style={{ marginBottom: '4px', fontWeight: 600 }}>
                Confidence Score: {percentage}%
            </div>
            <div style={{ fontSize: '11px', opacity: 0.9 }}>
                Based on data quality, metrics completeness, and model certainty
            </div>
            {/* Requirement 7.6: Display data_days and granularity information */}
            {(dataDays || granularity) && (
                <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: '1px solid rgba(255,255,255,0.2)' }}>
                    {dataDays && (
                        <div style={{ fontSize: '11px' }}>
                            Data Period: {dataDays} days
                        </div>
                    )}
                    {granularity && (
                        <div style={{ fontSize: '11px' }}>
                            Granularity: {granularity}
                        </div>
                    )}
                </div>
            )}
            {/* Arrow */}
            <div style={{
                position: 'absolute',
                top: '100%',
                left: '50%',
                transform: 'translateX(-50%)',
                width: 0,
                height: 0,
                borderLeft: '6px solid transparent',
                borderRight: '6px solid transparent',
                borderTop: '6px solid #1f2937'
            }} />
        </div>
    );

    return (
        <div
            style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', position: 'relative' }}
            onMouseEnter={() => setShowTooltip(true)}
            onMouseLeave={() => setShowTooltip(false)}
        >
            {showLabel && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Icon size={iconSize} style={{ color }} />
                    <span style={{ fontSize, fontWeight: 600, color }}>
                        {label}
                    </span>
                </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: showLabel ? 0 : 1 }}>
                <div
                    style={{
                        width: showLabel ? 60 : 100,
                        height: barHeight,
                        background: 'var(--az-bg)',
                        borderRadius: barHeight / 2,
                        overflow: 'hidden',
                        border: '1px solid var(--az-border)',
                    }}
                >
                    <div
                        style={{
                            width: `${percentage}%`,
                            height: '100%',
                            background: color,
                            transition: 'width 0.3s ease',
                        }}
                    />
                </div>
                <span style={{ fontSize, fontWeight: 600, color: 'var(--az-text-2)', minWidth: 32 }}>
                    {percentage}%
                </span>
            </div>
            {showWarning && (
                <Badge color="warning" size="small">
                    Low confidence
                </Badge>
            )}
            {/* Requirement 7.5: Tooltip */}
            {showTooltip && tooltipContent}
        </div>
    );
}
