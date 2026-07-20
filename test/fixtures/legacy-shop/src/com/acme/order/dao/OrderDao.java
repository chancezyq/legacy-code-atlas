package com.acme.order.dao;

public interface OrderDao {
    Order findForAudit(Long orderId);
    void updateStatus(Long orderId, String status);
    void insertAuditLog(Long orderId, String result);
}
