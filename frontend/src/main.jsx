import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './app.css';
import App from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { ToastProvider } from './components/Toast.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ToastProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </ToastProvider>
  </React.StrictMode>,
);
