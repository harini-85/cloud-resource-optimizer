import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import api from '../../services/api';
import { User, Mail, Building, AlertCircle, Loader2 } from 'lucide-react';
import FormInput from './shared/FormInput';
import PasswordInput from './shared/PasswordInput';
import PasswordStrength from './shared/PasswordStrength';
import { validateEmail, validatePassword, validateConfirmPassword } from './shared/validationUtils';

export default function Signup() {
    const navigate = useNavigate();
    const [formData, setFormData] = useState({
        username: '',
        email: '',
        password: '',
        confirmPassword: '',
        organization: '',
        acceptTerms: false
    });
    const [showPassword, setShowPassword] = useState(false);
    const [showConfirmPassword, setShowConfirmPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [validation, setValidation] = useState({
        email: { isValid: false, message: '' },
        password: { isValid: false, message: '' },
        confirmPassword: { isValid: false, message: '' }
    });
    const [touched, setTouched] = useState({
        email: false,
        password: false,
        confirmPassword: false
    });

    const handleChange = (e) => {
        const { name, value, type, checked } = e.target;
        setFormData(prev => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));

        // Real-time validation
        if (name === 'email' && touched.email) {
            setValidation(prev => ({ ...prev, email: validateEmail(value) }));
        }
        if (name === 'password' && touched.password) {
            setValidation(prev => ({ ...prev, password: validatePassword(value) }));
            // Also revalidate confirm password if it's been touched
            if (touched.confirmPassword && formData.confirmPassword) {
                setValidation(prev => ({ ...prev, confirmPassword: validateConfirmPassword(value, formData.confirmPassword) }));
            }
        }
        if (name === 'confirmPassword' && touched.confirmPassword) {
            setValidation(prev => ({ ...prev, confirmPassword: validateConfirmPassword(formData.password, value) }));
        }
    };

    const handleBlur = (field) => {
        setTouched(prev => ({ ...prev, [field]: true }));

        if (field === 'email') {
            setValidation(prev => ({ ...prev, email: validateEmail(formData.email) }));
        }
        if (field === 'password') {
            setValidation(prev => ({ ...prev, password: validatePassword(formData.password) }));
        }
        if (field === 'confirmPassword') {
            setValidation(prev => ({ ...prev, confirmPassword: validateConfirmPassword(formData.password, formData.confirmPassword) }));
        }
    };

    const passwordValidation = validatePassword(formData.password);
    const confirmPasswordValidation = validateConfirmPassword(formData.password, formData.confirmPassword);
    const isPasswordValid = passwordValidation.isValid;
    const passwordsMatch = confirmPasswordValidation.isValid;

    const handleSignup = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        setTouched({ email: true, password: true, confirmPassword: true });

        // Validate all fields
        const emailValidation = validateEmail(formData.email);
        const passwordValidation = validatePassword(formData.password);
        const confirmPasswordValidation = validateConfirmPassword(formData.password, formData.confirmPassword);

        if (!emailValidation.isValid) {
            setValidation(prev => ({ ...prev, email: emailValidation }));
            setLoading(false);
            return;
        }

        if (!passwordValidation.isValid) {
            setError(passwordValidation.message);
            setLoading(false);
            return;
        }

        if (!confirmPasswordValidation.isValid) {
            setError('Passwords do not match');
            setLoading(false);
            return;
        }

        if (!formData.acceptTerms) {
            setError('You must accept the Terms & Privacy Policy');
            setLoading(false);
            return;
        }

        try {
            const response = await api.post('/auth/signup', {
                username: formData.username,
                email: formData.email,
                password: formData.password,
                organization: formData.organization,
                role: 'Cloud Engineer',
                cloudProvider: 'AWS',
                termsAccepted: formData.acceptTerms,
            });

            if (response.data.token) {
                localStorage.setItem('token', response.data.token);
                localStorage.setItem('user', formData.username);
                localStorage.setItem('userId', response.data.userId);
                navigate('/cloud/dashboard');
            } else {
                navigate('/auth/login');
            }
        } catch (err) {
            setError(err.response?.data?.error || err.response?.data?.message || 'Signup failed. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div style={{
            display: 'flex',
            height: '100vh',
            width: '100vw',
            background: '#ffffff',
            position: 'fixed',
            top: 0,
            left: 0,
            overflow: 'hidden'
        }}>
            {/* Left side - Background Image */}
            <div style={{
                width: '50%',
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                backgroundColor: '#ffffff',
                backgroundImage: 'url(/Gemini_Generated_Image_490w2490w2490w24.png)',
                backgroundSize: '60%',
                backgroundPosition: 'center',
                backgroundRepeat: 'no-repeat'
            }}>
            </div>

            {/* Right side - Form */}
            <motion.div
                initial={{ opacity: 0, x: 50 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.8, ease: [0.25, 0.1, 0.25, 1] }}
                style={{
                    width: '50%',
                    padding: '15px 70px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    background: '#ffffff',
                    position: 'relative',
                    zIndex: 1
                }}
            >
                {/* Logo and title */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6, delay: 0.2 }}
                    style={{ marginBottom: '12px' }}
                >
                    <img
                        src="/logo.png"
                        alt="Cloud Optimizer"
                        style={{
                            height: '70px',
                            marginBottom: '10px',
                            display: 'block'
                        }}
                    />
                    <h1 style={{
                        fontSize: '20px',
                        fontWeight: '600',
                        color: '#2d3748',
                        marginBottom: '2px',
                        marginTop: 0
                    }}>
                        Create your account
                    </h1>
                    <p style={{
                        fontSize: '11px',
                        color: '#718096',
                        margin: 0
                    }}>
                        Start optimizing your cloud resources
                    </p>
                </motion.div>

                {/* Tab navigation */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6, delay: 0.3 }}
                    style={{
                        display: 'flex',
                        gap: '45px',
                        marginBottom: '14px'
                    }}
                >
                    <button
                        onClick={() => navigate('/auth/login')}
                        style={{
                            background: 'none',
                            border: 'none',
                            padding: '0 0 7px 0',
                            fontSize: '16px',
                            fontWeight: '500',
                            color: '#aaa',
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                            transition: 'color 0.2s'
                        }}
                        onMouseEnter={(e) => e.target.style.color = '#1a7a6e'}
                        onMouseLeave={(e) => e.target.style.color = '#aaa'}
                    >
                        Login
                    </button>
                    <button style={{
                        background: 'none',
                        border: 'none',
                        padding: '0 0 7px 0',
                        fontSize: '16px',
                        fontWeight: '500',
                        color: '#1a7a6e',
                        borderBottom: '2px solid #1a7a6e',
                        cursor: 'pointer',
                        fontFamily: 'inherit'
                    }}>
                        Sign up
                    </button>
                </motion.div>

                {/* Form */}
                <motion.form
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6, delay: 0.4 }}
                    onSubmit={handleSignup}
                    style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '10px',
                        maxWidth: '450px'
                    }}
                >
                    <FormInput
                        name="username"
                        type="text"
                        value={formData.username}
                        onChange={handleChange}
                        placeholder="Enter your full name"
                        label="Full Name"
                        icon={User}
                        required
                        autoComplete="name"
                    />

                    <FormInput
                        name="email"
                        type="email"
                        value={formData.email}
                        onChange={handleChange}
                        onBlur={() => handleBlur('email')}
                        placeholder="Enter your email"
                        label="Email"
                        icon={Mail}
                        required
                        validation={touched.email ? validation.email : undefined}
                        autoComplete="email"
                    />

                    <PasswordInput
                        name="password"
                        value={formData.password}
                        onChange={handleChange}
                        onBlur={() => handleBlur('password')}
                        placeholder="Create a password"
                        label="Password"
                        required
                        showStrengthIndicator={true}
                        autoComplete="new-password"
                    />

                    <PasswordInput
                        name="confirmPassword"
                        value={formData.confirmPassword}
                        onChange={handleChange}
                        onBlur={() => handleBlur('confirmPassword')}
                        placeholder="Confirm your password"
                        label="Confirm Password"
                        required
                        validation={touched.confirmPassword ? validation.confirmPassword : undefined}
                        autoComplete="new-password"
                    />

                    <FormInput
                        name="organization"
                        type="text"
                        value={formData.organization}
                        onChange={handleChange}
                        placeholder="Company name (optional)"
                        label="Organization"
                        icon={Building}
                        autoComplete="organization"
                    />

                    {/* Terms checkbox */}
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '5px', marginTop: '-4px' }}>
                        <input
                            id="terms"
                            name="acceptTerms"
                            type="checkbox"
                            checked={formData.acceptTerms}
                            onChange={handleChange}
                            style={{
                                width: '14px',
                                height: '14px',
                                marginTop: '1px',
                                accentColor: '#5bb8a8',
                                cursor: 'pointer'
                            }}
                        />
                        <label
                            htmlFor="terms"
                            style={{
                                fontSize: '10px',
                                color: '#718096',
                                cursor: 'pointer',
                                lineHeight: '1.3'
                            }}
                        >
                            I agree to the{' '}
                            <a href="#" style={{ color: '#5bb8a8', fontWeight: '600', textDecoration: 'none' }}>
                                Terms of Service
                            </a>
                            {' '}and{' '}
                            <a href="#" style={{ color: '#5bb8a8', fontWeight: '600', textDecoration: 'none' }}>
                                Privacy Policy
                            </a>
                        </label>
                    </div>

                    {/* Error message */}
                    {error && (
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            padding: '10px 12px',
                            background: '#fff5f5',
                            border: '1px solid #fc8181',
                            borderRadius: '10px',
                            fontSize: '12px',
                            color: '#c53030'
                        }}>
                            <AlertCircle size={16} />
                            <span>{error}</span>
                        </div>
                    )}

                    {/* Submit button */}
                    <button
                        type="submit"
                        disabled={!isPasswordValid || !passwordsMatch || !formData.acceptTerms || loading}
                        style={{
                            width: '100%',
                            padding: '10px 40px',
                            marginTop: '0px',
                            background: (!isPasswordValid || !passwordsMatch || !formData.acceptTerms || loading)
                                ? '#a0aec0'
                                : 'linear-gradient(135deg, #4ec9b0, #2aa08a)',
                            border: 'none',
                            borderRadius: '26px',
                            color: '#ffffff',
                            fontSize: '13px',
                            fontWeight: '500',
                            cursor: (!isPasswordValid || !passwordsMatch || !formData.acceptTerms || loading)
                                ? 'not-allowed'
                                : 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '7px',
                            transition: 'transform 0.2s, box-shadow 0.2s',
                            fontFamily: 'inherit',
                            boxShadow: (!isPasswordValid || !passwordsMatch || !formData.acceptTerms || loading)
                                ? 'none'
                                : '0 5px 18px rgba(78, 201, 176, 0.4)'
                        }}
                        onMouseEnter={(e) => {
                            if (isPasswordValid && passwordsMatch && formData.acceptTerms && !loading) {
                                e.target.style.transform = 'translateY(-2px)';
                                e.target.style.boxShadow = '0 8px 24px rgba(78, 201, 176, 0.5)';
                            }
                        }}
                        onMouseLeave={(e) => {
                            e.target.style.transform = 'translateY(0)';
                            if (isPasswordValid && passwordsMatch && formData.acceptTerms && !loading) {
                                e.target.style.boxShadow = '0 5px 18px rgba(78, 201, 176, 0.4)';
                            }
                        }}
                    >
                        {loading ? (
                            <>
                                <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
                                <span>Creating Account...</span>
                            </>
                        ) : (
                            <span>Sign up</span>
                        )}
                    </button>
                </motion.form>

                {/* Login link */}
                <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.6, delay: 0.6 }}
                    style={{
                        marginTop: '8px',
                        fontSize: '10px',
                        color: '#718096',
                        marginBottom: 0
                    }}
                >
                    Already have an account?{' '}
                    <button
                        onClick={() => navigate('/auth/login')}
                        style={{
                            background: 'none',
                            border: 'none',
                            color: '#5bb8a8',
                            fontWeight: '600',
                            cursor: 'pointer',
                            padding: 0,
                            fontFamily: 'inherit',
                            transition: 'color 0.2s',
                            fontSize: '10px'
                        }}
                        onMouseEnter={(e) => e.target.style.color = '#2aa08a'}
                        onMouseLeave={(e) => e.target.style.color = '#5bb8a8'}
                    >
                        Sign in
                    </button>
                </motion.p>
            </motion.div>

            <style>{`
                @keyframes spin {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                }
            `}</style>
        </div >
    );
}
