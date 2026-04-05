/** @type {import('tailwindcss').Config} */
export default {
    content: ['./index.html', './src/**/*.{js,ts,tsx}'],
    theme: {
        extend: {
            colors: {
                oreilly: {
                    red: '#d4002d',
                    'red-dark': '#a80024',
                    blue: '#0073e6',
                    'blue-dark': '#005bb5',
                    'blue-light': '#e8f4fc',
                },
                surface: {
                    50: '#fafafa',
                    100: '#f4f4f5',
                    200: '#e4e4e7',
                    300: '#d4d4d8',
                },
            },
            fontFamily: {
                sans: ['DM Sans', 'system-ui', '-apple-system', 'sans-serif'],
                mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
            },
            animation: {
                'fade-in': 'fadeIn 0.2s ease-out',
                'slide-down': 'slideDown 0.25s ease-out',
                shake: 'shake 0.4s ease',
                'pulse-subtle': 'pulseSubtle 2s ease-in-out infinite',
            },
            keyframes: {
                fadeIn: {
                    '0%': { opacity: '0' },
                    '100%': { opacity: '1' },
                },
                slideDown: {
                    '0%': { opacity: '0', transform: 'translateY(-8px)' },
                    '100%': { opacity: '1', transform: 'translateY(0)' },
                },
                shake: {
                    '0%, 100%': { transform: 'translateX(0)' },
                    '25%': { transform: 'translateX(-4px)' },
                    '75%': { transform: 'translateX(4px)' },
                },
                pulseSubtle: {
                    '0%, 100%': { opacity: '1' },
                    '50%': { opacity: '0.7' },
                },
            },
            boxShadow: {
                card: '0 1px 3px rgba(0,0,0,0.08)',
                'card-hover': '0 4px 12px rgba(0,0,0,0.1)',
                'card-expanded': '0 8px 30px rgba(0,0,0,0.12)',
                'inner-soft': 'inset 0 1px 2px rgba(0,0,0,0.06)',
            },
        },
    },
    plugins: [],
};
