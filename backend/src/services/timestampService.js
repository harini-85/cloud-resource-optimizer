/**
 * Timestamp Service
 * Calculates data coverage (date range) from CSV timestamp columns
 * Supports multiple timestamp formats and provides accurate data_days/data_hours
 */

const logger = require('../utils/logger');

/**
 * Detect timestamp column from CSV headers
 * @param {Array} headers - CSV column names
 * @returns {string|null} - Detected timestamp column name or null
 */
function detectTimestampColumn(headers) {
    const timestampVariations = [
        'timestamp', 'date', 'datetime', 'time', 'created_at', 'created_date', 'creation_time',
        'updated_at', 'modified_at', 'last_modified', 'last_updated', 'recorded_at', 'recorded_date',
        'start_time', 'end_time', 'last_seen', 'first_seen', 'observation_date', 'sample_date',
        'metric_date', 'data_date', 'collection_date', 'report_date', 'event_time', 'event_date',
        'measurement_time', 'measurement_date', 'capture_time', 'capture_date'
    ];

    // Case-insensitive search
    const lowerHeaders = headers.map(h => h.toLowerCase());

    for (const variation of timestampVariations) {
        const index = lowerHeaders.indexOf(variation);
        if (index !== -1) {
            return headers[index]; // Return original case
        }
    }

    return null;
}

/**
 * Parse timestamp string to Date object
 * Supports multiple formats
 * @param {string} timestampStr - Timestamp string
 * @returns {Date|null} - Parsed Date object or null if invalid
 */
function parseTimestamp(timestampStr) {
    if (!timestampStr || timestampStr.trim() === '') {
        return null;
    }

    const str = timestampStr.trim();

    // Try standard Date.parse first (handles ISO 8601, etc.)
    const standardDate = Date.parse(str);
    if (!isNaN(standardDate)) {
        return new Date(standardDate);
    }

    // Try Unix timestamp (seconds or milliseconds)
    const numericValue = Number(str);
    if (!isNaN(numericValue)) {
        // Unix timestamp in seconds (10 digits) or milliseconds (13 digits)
        if (numericValue.toString().length === 10) {
            return new Date(numericValue * 1000);
        } else if (numericValue.toString().length === 13) {
            return new Date(numericValue);
        }
    }

    // Try common date formats manually
    const dateFormats = [
        // YYYY-MM-DD HH:MM:SS
        /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/,
        // YYYY-MM-DD
        /^(\d{4})-(\d{2})-(\d{2})$/,
        // MM/DD/YYYY HH:MM:SS
        /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/,
        // MM/DD/YYYY
        /^(\d{2})\/(\d{2})\/(\d{4})$/,
        // DD-MM-YYYY HH:MM:SS
        /^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/,
        // DD-MM-YYYY
        /^(\d{2})-(\d{2})-(\d{4})$/,
    ];

    for (const format of dateFormats) {
        const match = str.match(format);
        if (match) {
            try {
                let year, month, day, hour = 0, minute = 0, second = 0;

                if (format.source.includes('YYYY-MM-DD')) {
                    [, year, month, day, hour, minute, second] = match;
                } else if (format.source.includes('MM/DD/YYYY')) {
                    [, month, day, year, hour, minute, second] = match;
                } else if (format.source.includes('DD-MM-YYYY')) {
                    [, day, month, year, hour, minute, second] = match;
                }

                const date = new Date(
                    parseInt(year),
                    parseInt(month) - 1, // Month is 0-indexed
                    parseInt(day),
                    parseInt(hour || 0),
                    parseInt(minute || 0),
                    parseInt(second || 0)
                );

                if (!isNaN(date.getTime())) {
                    return date;
                }
            } catch (e) {
                // Continue to next format
            }
        }
    }

    return null;
}

/**
 * Calculate timestamp range and data coverage from CSV rows
 * Enhanced to support duration columns as fallback when no timestamp columns exist
 * @param {Array} rows - Array of CSV row objects
 * @returns {Object} - { hasTimestamp, timestampColumn, minDate, maxDate, dataHours, dataDays, totalRows, validRows, invalidRows }
 */
function calculateTimestampRanges(rows) {
    if (!rows || rows.length === 0) {
        return {
            hasTimestamp: false,
            timestampColumn: null,
            minDate: null,
            maxDate: null,
            dataHours: null,
            dataDays: null,
            totalRows: 0,
            validRows: 0,
            invalidRows: 0
        };
    }

    const headers = Object.keys(rows[0]);

    // PRIORITY 1: Try to detect actual timestamp columns first (existing behavior)
    const timestampColumn = detectTimestampColumn(headers);

    if (timestampColumn) {
        logger.info(`[TimestampService] Detected timestamp column: "${timestampColumn}"`);

        // Parse all timestamps
        const timestamps = [];
        let validRows = 0;
        let invalidRows = 0;

        for (const row of rows) {
            const timestampStr = row[timestampColumn];
            const parsedDate = parseTimestamp(timestampStr);

            if (parsedDate) {
                timestamps.push(parsedDate);
                validRows++;
            } else {
                invalidRows++;
                logger.debug(`[TimestampService] Invalid timestamp: "${timestampStr}"`);
            }
        }

        if (timestamps.length === 0) {
            logger.warn('[TimestampService] No valid timestamps found in CSV');

            // Fallback to duration column detection if timestamp parsing failed
            const durationColumn = detectDurationColumn(headers);
            if (durationColumn) {
                logger.info('[TimestampService] Falling back to duration column detection');
                return calculateDurationRanges(rows, durationColumn);
            }

            return {
                hasTimestamp: false,
                timestampColumn,
                minDate: null,
                maxDate: null,
                dataHours: null,
                dataDays: null,
                totalRows: rows.length,
                validRows: 0,
                invalidRows
            };
        }

        // Calculate min and max dates
        const minDate = new Date(Math.min(...timestamps.map(d => d.getTime())));
        const maxDate = new Date(Math.max(...timestamps.map(d => d.getTime())));

        // Calculate range in milliseconds
        const rangeMs = maxDate.getTime() - minDate.getTime();

        // Convert to hours and days
        const dataHours = rangeMs / (1000 * 60 * 60); // milliseconds to hours
        const dataDays = Math.ceil(dataHours / 24); // Round up to nearest day

        logger.info(`[TimestampService] Calculated data coverage:`, {
            timestampColumn,
            minDate: minDate.toISOString(),
            maxDate: maxDate.toISOString(),
            dataHours: dataHours.toFixed(2),
            dataDays,
            validRows,
            invalidRows,
            totalRows: rows.length
        });

        return {
            hasTimestamp: true,
            timestampColumn,
            minDate,
            maxDate,
            dataHours: parseFloat(dataHours.toFixed(2)),
            dataDays,
            totalRows: rows.length,
            validRows,
            invalidRows
        };
    }

    // PRIORITY 2: No timestamp column found - try duration column detection (NEW FEATURE)
    const durationColumn = detectDurationColumn(headers);

    if (durationColumn) {
        logger.info('[TimestampService] No timestamp column found, using duration column detection');
        return calculateDurationRanges(rows, durationColumn);
    }

    // PRIORITY 3: No timestamp or duration columns found - return default
    logger.info('[TimestampService] No timestamp or duration column detected in CSV');
    return {
        hasTimestamp: false,
        timestampColumn: null,
        minDate: null,
        maxDate: null,
        dataHours: null,
        dataDays: null,
        totalRows: rows.length,
        validRows: 0,
        invalidRows: 0
    };
}

/**
 * Detect duration column from CSV headers
 * Looks for columns like running_hours_last_14d, running_hours_last_7d, uptime_hours
 * @param {Array} headers - CSV column names
 * @returns {string|null} - Detected duration column name or null
 */
function detectDurationColumn(headers) {
    const durationPatterns = [
        /^running_hours_last_\d+d$/i,  // running_hours_last_14d, running_hours_last_7d
        /^uptime_hours_\d+d$/i,         // uptime_hours_14d, uptime_hours_7d
        /^hours_last_\d+d$/i,           // hours_last_14d, hours_last_7d
        /^uptime_hours$/i,              // uptime_hours (generic)
        /^running_hours_last_\d+$/i    // running_hours_last_14, running_hours_last_7 (without 'd')
    ];

    // Case-insensitive search
    for (const header of headers) {
        const lowerHeader = header.toLowerCase();

        for (const pattern of durationPatterns) {
            if (pattern.test(lowerHeader)) {
                return header; // Return original case
            }
        }
    }

    return null;
}

/**
 * Extract number of days from duration column name
 * Examples: "running_hours_last_14d" → 14, "uptime_hours_7d" → 7
 * @param {string} columnName - Duration column name
 * @returns {number|null} - Number of days or null if not found
 */
function extractDaysFromColumnName(columnName) {
    if (!columnName) return null;

    const lowerName = columnName.toLowerCase();

    // Pattern 1: Extract from "_Xd" format (e.g., "_14d", "_7d")
    const daysMatch = lowerName.match(/_(\d+)d$/);
    if (daysMatch) {
        return parseInt(daysMatch[1]);
    }

    // Pattern 2: Extract from "_last_X" format without 'd' (e.g., "_last_14", "_last_7")
    const lastMatch = lowerName.match(/_last_(\d+)$/);
    if (lastMatch) {
        return parseInt(lastMatch[1]);
    }

    // Pattern 3: Generic uptime_hours - no days in name, will calculate from hours value
    if (lowerName === 'uptime_hours') {
        return null; // Will be calculated from hours value
    }

    return null;
}

/**
 * Calculate data coverage from duration column
 * @param {Array} rows - Array of CSV row objects
 * @param {string} durationColumn - Name of the duration column
 * @returns {Object} - Same structure as calculateTimestampRanges
 */
function calculateDurationRanges(rows, durationColumn) {
    if (!rows || rows.length === 0 || !durationColumn) {
        return {
            hasTimestamp: false,
            timestampColumn: null,
            minDate: null,
            maxDate: null,
            dataHours: null,
            dataDays: null,
            totalRows: rows ? rows.length : 0,
            validRows: 0,
            invalidRows: 0
        };
    }

    logger.info(`[TimestampService] Detected duration column: "${durationColumn}"`);

    // Extract days from column name (if pattern exists)
    const daysFromName = extractDaysFromColumnName(durationColumn);

    // Parse all hours values
    const hoursValues = [];
    let validRows = 0;
    let invalidRows = 0;

    for (const row of rows) {
        const hoursStr = row[durationColumn];
        const hoursValue = parseFloat(hoursStr);

        if (!isNaN(hoursValue) && hoursValue > 0) {
            hoursValues.push(hoursValue);
            validRows++;
        } else {
            invalidRows++;
            logger.debug(`[TimestampService] Invalid hours value: "${hoursStr}"`);
        }
    }

    if (hoursValues.length === 0) {
        logger.warn('[TimestampService] No valid hours values found in duration column');
        return {
            hasTimestamp: false,
            timestampColumn: durationColumn,
            minDate: null,
            maxDate: null,
            dataHours: null,
            dataDays: null,
            totalRows: rows.length,
            validRows: 0,
            invalidRows
        };
    }

    // Calculate data coverage
    let dataHours, dataDays;

    if (daysFromName !== null) {
        // Use days from column name for precise calculation
        dataDays = daysFromName;
        // Use average hours value from CSV (should be consistent)
        const avgHours = hoursValues.reduce((sum, h) => sum + h, 0) / hoursValues.length;
        dataHours = avgHours;

        logger.info(`[TimestampService] Using days from column name: ${dataDays} days`);
    } else {
        // Calculate from hours values (for generic columns like "uptime_hours")
        const avgHours = hoursValues.reduce((sum, h) => sum + h, 0) / hoursValues.length;
        dataHours = avgHours;
        dataDays = Math.ceil(dataHours / 24); // Round up to nearest day

        logger.info(`[TimestampService] Calculated from hours value: ${dataDays} days`);
    }

    // Create synthetic date range (current time as max, subtract coverage for min)
    const maxDate = new Date();
    const minDate = new Date(maxDate.getTime() - (dataHours * 60 * 60 * 1000));

    logger.info(`[TimestampService] Calculated data coverage from duration column:`, {
        durationColumn,
        dataHours: dataHours.toFixed(2),
        dataDays,
        validRows,
        invalidRows,
        totalRows: rows.length
    });

    return {
        hasTimestamp: true, // Duration column detected
        timestampColumn: durationColumn,
        minDate,
        maxDate,
        dataHours: parseFloat(dataHours.toFixed(2)),
        dataDays,
        totalRows: rows.length,
        validRows,
        invalidRows
    };
}

module.exports = {
    detectTimestampColumn,
    parseTimestamp,
    calculateTimestampRanges,
    detectDurationColumn,
    extractDaysFromColumnName,
    calculateDurationRanges
};
