import { motion } from 'framer-motion';

// Reusable animated section component with fade-in-up animation
export const AnimatedSection = ({
    children,
    delay = 0,
    duration = 0.6,
    className = '',
    ...props
}) => {
    return (
        <motion.div
            initial={{ opacity: 0, y: 50 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{
                duration,
                delay,
                ease: [0.25, 0.1, 0.25, 1]
            }}
            className={className}
            {...props}
        >
            {children}
        </motion.div>
    );
};

// Animated container with staggered children
export const AnimatedContainer = ({
    children,
    staggerDelay = 0.2,
    className = '',
    ...props
}) => {
    return (
        <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: '-100px' }}
            variants={{
                hidden: { opacity: 0 },
                visible: {
                    opacity: 1,
                    transition: {
                        staggerChildren: staggerDelay
                    }
                }
            }}
            className={className}
            {...props}
        >
            {children}
        </motion.div>
    );
};

// Animated item for use within AnimatedContainer
export const AnimatedItem = ({
    children,
    duration = 0.6,
    className = '',
    ...props
}) => {
    return (
        <motion.div
            variants={{
                hidden: { opacity: 0, y: 50 },
                visible: {
                    opacity: 1,
                    y: 0,
                    transition: {
                        duration,
                        ease: [0.25, 0.1, 0.25, 1]
                    }
                }
            }}
            className={className}
            {...props}
        >
            {children}
        </motion.div>
    );
};

// Fade in animation (no vertical movement)
export const FadeIn = ({
    children,
    delay = 0,
    duration = 0.6,
    className = '',
    ...props
}) => {
    return (
        <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{
                duration,
                delay,
                ease: 'easeOut'
            }}
            className={className}
            {...props}
        >
            {children}
        </motion.div>
    );
};

// Scale animation
export const ScaleIn = ({
    children,
    delay = 0,
    duration = 0.5,
    className = '',
    ...props
}) => {
    return (
        <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{
                duration,
                delay,
                ease: [0.25, 0.1, 0.25, 1]
            }}
            className={className}
            {...props}
        >
            {children}
        </motion.div>
    );
};

// Slide in from left
export const SlideInLeft = ({
    children,
    delay = 0,
    duration = 0.6,
    className = '',
    ...props
}) => {
    return (
        <motion.div
            initial={{ opacity: 0, x: -50 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{
                duration,
                delay,
                ease: [0.25, 0.1, 0.25, 1]
            }}
            className={className}
            {...props}
        >
            {children}
        </motion.div>
    );
};

// Slide in from right
export const SlideInRight = ({
    children,
    delay = 0,
    duration = 0.6,
    className = '',
    ...props
}) => {
    return (
        <motion.div
            initial={{ opacity: 0, x: 50 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{
                duration,
                delay,
                ease: [0.25, 0.1, 0.25, 1]
            }}
            className={className}
            {...props}
        >
            {children}
        </motion.div>
    );
};
