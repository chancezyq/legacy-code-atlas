function reloadOrder(orderId) {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/order/detail.do?id=' + orderId, true);
  return fetch("/order/permission/check.do");
}
fetch("/api/orders/list");
