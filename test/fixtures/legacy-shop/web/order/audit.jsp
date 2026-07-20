<%@ page contentType="text/html;charset=UTF-8" %>
<%@ include file="/common/tags.jsp" %>
<html>
<head><title>订单审核</title></head>
<body>
  <jsp:include page="/common/header.jsp" />
  <h1>订单审核</h1>
  <form id="auditForm" action="${pageContext.request.contextPath}/order/audit.do" method="post">
    <input type="hidden" name="orderId" value="${order.id}" />
    <input type="hidden" name="method" value="audit" />
    <select name="decision"><option value="PASS">审核通过</option></select>
    <button type="submit">提交审核</button>
  </form>
  <a href="/order/list.do">返回订单列表</a>
  <script src="/js/order.js"></script>
  <script>
    fetch('/order/audit/status.do?id=' + orderId);
    $.ajax({ url: '<c:url value="/order/audit/history.do" />', method: 'GET' });
  </script>
</body>
</html>
