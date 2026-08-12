import Razorpay from 'razorpay';
import crypto from 'crypto';

// Initialize Razorpay SDK instance if credentials are present in process.env
const getRazorpayInstance = () => {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;

  if (key_id && key_secret && key_id !== 'YOUR_RAZORPAY_KEY_ID') {
    return new Razorpay({ key_id, key_secret });
  }
  return null;
};

/**
 * Create Razorpay Order
 * Converts INR amount to paise (amount * 100)
 */
export const createRazorpayOrder = async (amountInInr, receiptId) => {
  const amountInPaise = Math.round(Number(amountInInr) * 100);
  const razorpay = getRazorpayInstance();

  if (razorpay) {
    const options = {
      amount: amountInPaise,
      currency: 'INR',
      receipt: receiptId || `receipt_${Date.now()}`,
      payment_capture: 1
    };
    const order = await razorpay.orders.create(options);
    return {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.RAZORPAY_KEY_ID,
      isSandbox: false
    };
  }

  // Developer Sandbox Fallback if credentials not set in .env
  console.log(`⚠️ Razorpay credentials not configured in .env — using Sandbox Fallback for development testing.`);
  const sandboxOrderId = `order_sandbox_${Math.floor(100000 + Math.random() * 900000)}`;
  return {
    orderId: sandboxOrderId,
    amount: amountInPaise,
    currency: 'INR',
    key: process.env.RAZORPAY_KEY_ID || 'rzp_test_sandbox_key',
    isSandbox: true
  };
};

/**
 * Cryptographic HMAC SHA256 Signature Verification
 */
export const verifyRazorpayPaymentSignature = ({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) => {
  const key_secret = process.env.RAZORPAY_KEY_SECRET;

  // If running in sandbox fallback mode
  if (String(razorpayOrderId).startsWith('order_sandbox_') || !key_secret || key_secret === 'YOUR_RAZORPAY_KEY_SECRET') {
    return true; // Sandbox bypass
  }

  const generatedSignature = crypto
    .createHmac('sha256', key_secret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  return generatedSignature === razorpaySignature;
};

/**
 * Financial Safety Net: Verify Razorpay Order Amount matches Expected Item Total
 */
export const verifyRazorpayOrderAmount = async (razorpayOrderId, expectedAmountInInr) => {
  const razorpay = getRazorpayInstance();
  const expectedPaise = Math.round(Number(expectedAmountInInr) * 100);

  if (!razorpay || String(razorpayOrderId).startsWith('order_sandbox_')) {
    return true; // Sandbox bypass
  }

  try {
    const orderDetails = await razorpay.orders.fetch(razorpayOrderId);
    return orderDetails && orderDetails.amount === expectedPaise;
  } catch (err) {
    console.error(`Error fetching Razorpay order ${razorpayOrderId}:`, err);
    return false;
  }
};

/**
 * Modular helper to process successful payment record
 * Future-proofed for Razorpay Webhook (order.paid event)
 */
export const processSuccessfulPaymentRecord = async ({
  razorpayOrderId,
  razorpayPaymentId,
  razorpaySignature,
  expectedGrandTotal
}) => {
  // 1. Check Signature Integrity
  const isSignatureValid = verifyRazorpayPaymentSignature({
    razorpayOrderId,
    razorpayPaymentId,
    razorpaySignature
  });

  if (!isSignatureValid) {
    return {
      success: false,
      error: 'CRITICAL: Razorpay HMAC SHA256 Signature Verification Failed! Fraudulent payment attempt blocked.'
    };
  }

  // 2. Check Price Mismatch Integrity
  const isAmountValid = await verifyRazorpayOrderAmount(razorpayOrderId, expectedGrandTotal);
  if (!isAmountValid) {
    return {
      success: false,
      error: 'CRITICAL: Payment Amount Mismatch Detected! Order total does not match Razorpay order amount.'
    };
  }

  return {
    success: true,
    paymentMethod: 'Razorpay Online',
    paymentStatus: 'PAID (Razorpay)',
    razorpayOrderId,
    razorpayPaymentId
  };
};
