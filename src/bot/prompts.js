// Простейший роутер «ожидаем текст от пользователя».
// Модули регистрируют обработчик шага, состояние лежит в ctx.session.await.
const handlers = new Map();

function register(type, handler) {
  handlers.set(type, handler);
}

function ask(ctx, type, payload = {}) {
  ctx.session.await = { type, ...payload };
}

function clear(ctx) {
  if (ctx.session) delete ctx.session.await;
}

async function dispatch(ctx) {
  const state = ctx.session && ctx.session.await;
  if (!state) return false;

  const handler = handlers.get(state.type);
  if (!handler) {
    clear(ctx);
    return false;
  }

  await handler(ctx, state);
  return true;
}

module.exports = { register, ask, clear, dispatch };
