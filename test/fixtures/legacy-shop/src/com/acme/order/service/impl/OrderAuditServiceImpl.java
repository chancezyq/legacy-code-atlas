package com.acme.order.service.impl;

import com.acme.order.dao.OrderDao;
import com.acme.order.service.OrderAuditService;

public class OrderAuditServiceImpl implements OrderAuditService {
    private OrderDao orderDao;

    public void audit(Long orderId) {
        orderDao.updateStatus(orderId, "APPROVED");
        orderDao.insertAuditLog(orderId, "PASS");
    }
}
