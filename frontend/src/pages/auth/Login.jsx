import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Mail, AlertCircle, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import api from '../../services/api';
import FormInput from './shared/FormInput';
import PasswordInput from './shared/PasswordInput';
import { validateEmail } from './shared/validationUtils';

export default function Login() {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const [formData, setFormData] = useState({ email: '', password: '' });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [validation, setValidation] = useState({
        email: { isValid: false, message: '' },
        password: { isValid: false, message: '' }
    });
    const [touched, setTouched] = useState({ email: false, password: false });

    useEffect(() => {
        if (localStorage.getItem('token')) navigate('/cloud/dashboard');
    }, [navigate]);

    const handleChange = (e) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));

        // Real-time validation
        if (name === 'email' && touched.email) {
            setValidation(prev => ({ ...prev, email: validateEmail(value) }));
        }
    };

    const handleBlur = (field) => {
        setTouched(prev => ({ ...prev, [field]: true }));

        if (field === 'email') {
            setValidation(prev => ({ ...prev, email: validateEmail(formData.email) }));
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        setTouched({ email: true, password: true });

        // Validate all fields
        const emailValidation = validateEmail(formData.email);
        if (!emailValidation.isValid) {
            setValidation(prev => ({ ...prev, email: emailValidation }));
            setLoading(false);
            return;
        }

        if (!formData.password) {
            setError('Password is required');
            setLoading(false);
            return;
        }

        try {
            const res = await api.post('/auth/login', {
                username: formData.email,
                password: formData.password
            });

            const { token, username, userId } = res.data;
            localStorage.setItem('token', token);
            localStorage.setItem('user', username);
            localStorage.setItem('userId', userId);

            const returnUrl = searchParams.get('returnUrl');
            navigate(returnUrl ? decodeURIComponent(returnUrl) : '/mode');
        } catch (err) {
            setError(err.response?.data?.error || err.response?.data?.message || 'Login failed. Please check your credentials.');
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
                    padding: '60px 80px',
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
                    style={{ marginBottom: '40px' }}
                >
                    <img
                        src="/logo.png"
                        alt="Cloud Optimizer"
                        style={{
                            height: '80px',
                            marginBottom: '20px',
                            display: 'block'
                        }}
                    />
                    <h1 style={{
                        fontSize: '28px',
                        fontWeight: '600',
                        color: '#2d3748',
                        marginBottom: '6px',
                        marginTop: 0
                    }}>
                        Welcome back
                    </h1>
                    <p style={{
                        fontSize: '14px',
                        color: '#718096',
                        margin: 0
                    }}>
                        Sign in to continue to Cloud Optimizer
                    </p>
                </motion.div>

                {/* Tab navigation */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6, delay: 0.3 }}
                    style={{
                        display: 'flex',
                        gap: '60px',
                        marginBottom: '40px'
                    }}
                >
                    <button style={{
                        background: 'none',
                        border: 'none',
                        padding: '0 0 12px 0',
                        fontSize: '22px',
                        fontWeight: '500',
                        color: '#1a7a6e',
                        borderBottom: '2px solid #1a7a6e',
                        cursor: 'pointer',
                        fontFamily: 'inherit'
                    }}>
                        Login
                    </button>
                    <button
                        onClick={() => navigate('/auth/signup')}
                        style={{
                            background: 'none',
                            border: 'none',
                            padding: '0 0 12px 0',
                            fontSize: '22px',
                            fontWeight: '500',
                            color: '#aaa',
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                            transition: 'color 0.2s'
                        }}
                        onMouseEnter={(e) => e.target.style.color = '#1a7a6e'}
                        onMouseLeave={(e) => e.target.style.color = '#aaa'}
                    >
                        Sign up
                    </button>
                </motion.div>

                {/* Form */}
                <motion.form
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6, delay: 0.4 }}
                    onSubmit={handleSubmit}
                    style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '20px',
                        maxWidth: '480px'
                    }}
                >
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
                        placeholder="Enter your password"
                        label="Password"
                        required
                        autoComplete="current-password"
                    />

                    {/* Submit button */}
                    <div style={{
                        display: 'flex',
                        justifyContent: 'center',
                        marginTop: '10px'
                    }}>
                        <button
                            type="submit"
                            disabled={loading}
                            style={{
                                padding: '14px 52px',
                                background: loading ? '#a0aec0' : 'linear-gradient(135deg, #4ec9b0, #2aa08a)',
                                border: 'none',
                                borderRadius: '30px',
                                color: '#ffffff',
                                fontSize: '16px',
                                fontWeight: '500',
                                cursor: loading ? 'not-allowed' : 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '10px',
                                transition: 'transform 0.2s, box-shadow 0.2s',
                                fontFamily: 'inherit',
                                boxShadow: '0 6px 20px rgba(78, 201, 176, 0.4)'
                            }}
                            onMouseEnter={(e) => {
                                if (!loading) {
                                    e.target.style.transform = 'translateY(-2px)';
                                    e.target.style.boxShadow = '0 10px 28px rgba(78, 201, 176, 0.5)';
                                }
                            }}
                            onMouseLeave={(e) => {
                                e.target.style.transform = 'translateY(0)';
                                e.target.style.boxShadow = '0 6px 20px rgba(78, 201, 176, 0.4)';
                            }}
                        >
                            {loading ? (
                                <>
                                    <Loader2 size={20} style={{ animation: 'spin 1s linear infinite' }} />
                                    <span>Signing in...</span>
                                </>
                            ) : (
                                <span>Login</span>
                            )}
                        </button>
                    </div>

                    {/* Error message */}
                    {error && (
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '10px',
                            padding: '14px 16px',
                            background: '#fff5f5',
                            border: '1px solid #fc8181',
                            borderRadius: '12px',
                            fontSize: '14px',
                            color: '#c53030',
                            marginTop: '-10px'
                        }}>
                            <AlertCircle size={18} />
                            <span>{error}</span>
                        </div>
                    )}
                </motion.form>

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
