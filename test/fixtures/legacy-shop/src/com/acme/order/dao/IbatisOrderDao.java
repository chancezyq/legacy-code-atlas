package com.acme.order.dao;

import org.springframework.orm.ibatis.support.SqlMapClientDaoSupport;

public class IbatisOrderDao extends SqlMapClientDaoSupport implements OrderDao {
    public Order findForAudit(Long orderId) {
        return (Order) getSqlMapClientTemplate().queryForObject("order.findForAudit", orderId);
    }

    public void updateStatus(Long orderId, String status) {
        // update("ignored.fakeStatement", orderId);
        getSqlMapClientTemplate().update("order.updateStatus", orderId);
    }

    public void insertAuditLog(Long orderId, String result) {
        getSqlMapClientTemplate().insert("order.insertAuditLog", orderId);
    }

    public void unresolvedStatement(Long orderId) {
        getSqlMapClientTemplate().delete("order.missingStatement", orderId);
    }
}
