let checkoutScript;

export function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  if (!checkoutScript) {
    checkoutScript = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.onload = () => window.Razorpay ? resolve() : reject(new Error('Payment checkout could not load.'));
      script.onerror = () => {
        script.remove();
        reject(new Error('Payment checkout could not load. Check your connection and retry.'));
      };
      document.head.appendChild(script);
    }).catch(error => { checkoutScript = undefined; throw error; });
  }
  return checkoutScript;
}

export async function openRazorpay(payment, user) {
  await loadRazorpay();
  return new Promise((resolve, reject) => {
    let confirmed = false;
    const checkout = new window.Razorpay({
      key: payment.key, order_id: payment.order_id,
      amount: payment.amount, currency: payment.currency,
      name: 'SPARK-DV',
      description: payment.test ? 'Test payment · SPARK-DV order' : 'SPARK-DV order',
      prefill: { name: user.name, email: user.email?.endsWith('@phone.sparkdv.invalid') ? '' : user.email, contact: user.mobile || '' },
      theme: { color: '#073763' },
      handler: result => { confirmed = true; resolve(result); },
      modal: { ondismiss: () => { if (!confirmed) reject(Object.assign(new Error('Payment window closed. Your order and cart are saved; you can retry payment.'), {code: 'checkout-closed'})); } },
    });
    checkout.on('payment.failed', () => {
      checkout.close();
      reject(new Error('Payment failed. You can try again with another payment method.'));
    });
    checkout.open();
  });
}
