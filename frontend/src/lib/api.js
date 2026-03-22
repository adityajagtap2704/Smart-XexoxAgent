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
  register:        (data)  => api.post('/auth/register', data),
  login:           (data)  => api.post('/auth/login', data),
  verifyOTP:       (data)  => api.post('/auth/verify-otp', data),
  // FIX: was /auth/profile (route does not exist) — correct route is /auth/me
  getMe:           ()      => api.get('/auth/me'),
  getProfile:      ()      => api.get('/auth/me'),
  forgotPassword:  (email) => api.post('/auth/forgot-password', { email }),
  resetPassword:   (data)  => api.post('/auth/reset-password', data),
  logout:          ()      => api.post('/auth/logout'),
};

// User Profile
export const userAPI = {
  getProfile:           ()      => api.get('/users/profile'),
  updateProfile:        (data)  => api.patch('/users/profile', data),
  requestContactChange: (data)  => api.post('/users/request-change', data),
  verifyContactChange:  (data)  => api.post('/users/verify-change', data),
  getStats:             ()      => api.get('/users/stats'),
  getOrderHistory:      ()      => api.get('/users/orders'),
};

// Orders
export const orderAPI = {
  // Order is created with JSON body (documents array with S3 urls, NOT FormData)
  create:          (data)          => api.post('/orders', data),
  getAll:          ()              => api.get('/orders'),
  getById:         (id)            => api.get(`/orders/${id}`),
  // FIX: was api.put — backend route is PATCH
  updateStatus:    (id, status)    => api.patch(`/orders/${id}/status`, { status }),
  cancel:          (id)            => api.delete(`/orders/${id}`),
  getMyOrders:     ()              => api.get('/orders/my-orders'),
  // FIX: was api.post('/orders/:id/verify-pickup') — backend route is POST /orders/verify-pickup with orderId in body
  verifyPickup:    (data)          => api.post('/orders/verify-pickup', data),
  retryPayment:    (id)            => api.post(`/orders/retry/${id}`),
  extendExpiry:    (id)            => api.post(`/orders/${id}/extend`),
  // FIX: added missing accept / reject / getDocumentUrl
  accept:          (id)            => api.patch(`/orders/${id}/accept`),
  reject:          (id, reason)    => api.patch(`/orders/${id}/reject`, { reason }),
  getDocumentUrl:  (orderId, docId)=> api.get(`/orders/${orderId}/documents/${docId}/url`),
};

// Shops
export const shopAPI = {
  getAll:          ()      => api.get('/shops'),
  getById:         (id)    => api.get(`/shops/${id}`),
  create:          (data)  => api.post('/shops', data),
  update:          (data)  => api.patch('/shops/my-shop', data),
  delete:          (id)    => api.delete(`/shops/${id}`),
  // FIX: GET /shops/my-shop does not exist — use dashboard endpoint
  getMyShop:       ()      => api.get('/shops/my-shop/dashboard'),
  updatePricing:   (data)  => api.patch('/shops/my-shop', { pricing: data }),
  toggleStatus:    ()      => api.patch('/shops/my-shop/toggle-status'),
  // FIX: was /shops/orders (404) — correct route is /orders/shop/orders
  getShopOrders:   ()      => api.get('/orders/shop/orders'),
};

// Payments
export const paymentAPI = {
  // FIX: removed paymentAPI.createOrder — razorpay data comes from orderAPI.create() response
  // Verify uses camelCase field names to match backend expectation
  verify: (data) => api.post('/payments/verify', data),
  getDetails: (orderId) => api.get(`/payments/order/${orderId}`),
  refund: (data) => api.post('/payments/refund', data),
};

// Upload — call this FIRST before placing order to get S3 url
export const uploadAPI = {
  // FIX: was /upload (404) — correct endpoint is /upload/single
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
  getAll:      ()         => api.get('/notifications'),
  markRead:    (ids)      => api.patch('/notifications/read', { ids }),
  markAllRead: ()         => api.patch('/notifications/read-all'),
  delete:      (id)       => api.delete(`/notifications/${id}`),
};

// Admin
export const adminAPI = {
  getDashboard:  ()        => api.get('/admin/dashboard'),
  getAnalytics:  ()        => api.get('/admin/analytics'),
  getRevenue:    ()        => api.get('/admin/revenue'),
  getUsers:      ()        => api.get('/admin/users'),
  toggleUser:    (id)      => api.patch(`/admin/users/${id}/toggle-status`),
  getShops:      ()        => api.get('/admin/shops'),
  verifyShop:    (id, data)=> api.patch(`/admin/shops/${id}/verify`, data),
  setMargin:     (id, data)=> api.patch(`/admin/shops/${id}/margin`, data),
  getOrders:     ()        => api.get('/admin/orders'),
  broadcast:     (data)    => api.post('/admin/notifications/broadcast', data),
};

export default api;