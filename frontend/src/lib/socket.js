import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';

let socket = null;

export const getSocket = () => {
  if (!socket) {
    const token = localStorage.getItem('token');
    socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
    });
  }
  return socket;
};

export const disconnectSocket = () => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
};

export const joinOrderRoom = (orderId) => {
  const s = getSocket();
  s.emit('join-order', orderId);
};

export const joinShopRoom = (shopId) => {
  const s = getSocket();
  if (!shopId) return;
  s.emit('join:shop', shopId);
};

export const onShopStatusUpdate = (callback) => {
  const s = getSocket();
  s.on('shop:status_update', callback);
  return () => { s.off('shop:status_update', callback); };
};

export const onOrderUpdate = (callback) => {
  const s = getSocket();
  // FIX: was 'order-update' — backend emits 'order:status_update'
  s.on('order:status_update', callback);
  return () => { s.off('order:status_update', callback); };
};

export const onPaymentSuccess = (callback) => {
  const s = getSocket();
  s.on('payment:success', callback);
  return () => { s.off('payment:success', callback); };
};

export const onNotification = (callback) => {
  const s = getSocket();
  s.on('notification', callback);
  return () => { s.off('notification', callback); };
};

export const onNewOrder = (callback) => {
  const s = getSocket();
  s.on('order:new', callback);
  return () => { s.off('order:new', callback); };
};
