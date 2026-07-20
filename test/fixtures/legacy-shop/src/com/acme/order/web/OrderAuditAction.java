package com.acme.order.web;

import com.acme.order.service.OrderAuditService;
import org.apache.struts.action.DispatchAction;

public class OrderAuditAction extends DispatchAction {
    private OrderAuditService orderAuditService;

    public void setOrderAuditService(OrderAuditService orderAuditService) {
        this.orderAuditService = orderAuditService;
    }

    public ActionForward audit(ActionMapping mapping, ActionForm form,
            HttpServletRequest request, HttpServletResponse response) throws Exception {
        Long orderId = Long.valueOf(request.getParameter("orderId"));
        orderAuditService.audit(orderId);
        return mapping.findForward("success");
    }
}
