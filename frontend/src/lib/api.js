import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// Auth
export const authAPI = {
  register:       (data)  => api.post('/auth/register', data),
  verifyEmail:    (data)  => api.post('/auth/verify-email', data), // NEW — OTP verification after register
  login:          (data)  => api.post('/auth/login', data),
  verifyOTP:      (data)  => api.post('/auth/verify-otp', data),
  getMe:          ()      => api.get('/auth/me'),
  getProfile:     ()      => api.get('/auth/me'),
  forgotPassword: (email) => api.post('/auth/forgot-password', { email }),
  resetPassword:  (data)  => api.post('/auth/reset-password', data),
  logout:         ()      => api.post('/auth/logout'),
};

// Orders
export const orderAPI = {
  create:         (data)           => api.post('/orders', data),
  getAll:         ()               => api.get('/orders'),
  getById:        (id)             => api.get(`/orders/${id}`),
  updateStatus:   (id, status)     => api.patch(`/orders/${id}/status`, { status }),
  cancel:         (id)             => api.delete(`/orders/${id}`),
  getMyOrders:    ()               => api.get('/orders/my-orders'),
  verifyPickup:   (data)           => api.post('/orders/verify-pickup', data),
  extendExpiry:   (id)             => api.post(`/orders/${id}/extend`),
  accept:         (id)             => api.patch(`/orders/${id}/accept`),
  reject:         (id, reason)     => api.patch(`/orders/${id}/reject`, { reason }),
  getDocumentUrl: (orderId, docId) => api.get(`/orders/${orderId}/documents/${docId}/url`),
};

// Shops
export const shopAPI = {
  getAll:        ()     => api.get('/shops'),
  getById:       (id)   => api.get(`/shops/${id}`),
  create:        (data) => api.post('/shops', data),
  update:        (data) => api.patch('/shops/my-shop', data),
  delete:        (id)   => api.delete(`/shops/${id}`),
  getMyShop:     ()     => api.get('/shops/my-shop/dashboard'),
  updatePricing: (data) => api.patch('/shops/my-shop', { pricing: data }),
  toggleStatus:  ()     => api.patch('/shops/my-shop/toggle-status'),
  getShopOrders: ()     => api.get('/orders/shop/orders'),
};

// Payments
export const paymentAPI = {
  verify:     (data)    => api.post('/payments/verify', data),
  getDetails: (orderId) => api.get(`/payments/order/${orderId}`),
  refund:     (data)    => api.post('/payments/refund', data),
};

// Upload
export const uploadAPI = {
  uploadFile: (file) => {
    const formData = new FormData();
    formData.append('document', file);
    return api.post('/upload/single', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
  uploadMultiple: (files) => {
    const formData = new FormData();
    files.forEach(f => formData.append('documents', f));
    return api.post('/upload/multiple', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
  getSignedUrl: (key) => api.get(`/upload/signed-url?key=${key}`),
};

// Notifications
export const notificationAPI = {
  getAll:      ()    => api.get('/notifications'),
  markRead:    (ids) => api.patch('/notifications/read', { ids }),
  markAllRead: ()    => api.patch('/notifications/read-all'),
  delete:      (id)  => api.delete(`/notifications/${id}`),
};

// Admin
export const adminAPI = {
  getDashboard: ()         => api.get('/admin/dashboard'),
  getAnalytics: ()         => api.get('/admin/analytics'),
  getRevenue:   ()         => api.get('/admin/revenue'),
  getUsers:     ()         => api.get('/admin/users'),
  toggleUser:   (id)       => api.patch(`/admin/users/${id}/toggle-status`),
  getShops:     ()         => api.get('/admin/shops'),
  verifyShop:   (id, data) => api.patch(`/admin/shops/${id}/verify`, data),
  setMargin:    (id, data) => api.patch(`/admin/shops/${id}/margin`, data),
  getOrders:    ()         => api.get('/admin/orders'),
  broadcast:    (data)     => api.post('/admin/notifications/broadcast', data),
};

export default api;