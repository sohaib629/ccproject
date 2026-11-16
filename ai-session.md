# AI Interaction Record

These two examples show how we reviewed AI assistance and verified its suggestions rather
than accepting them without checking.

---

## 1. Frontend Development

### Prompt
Build an Admin page for managing products and users.

### AI Response
Suggested React components for product management, user administration and change
history.

### What We Did With It
- Manual testing exposed a dialog layout issue and a session-handling bug after password
  resets; we corrected both.
- Tested admin actions, role-based access and account deactivation to verify the fixes.

---

## 2. DigitalOcean Cost Estimation

### Prompt
Estimate the cost of running StockSync on DigitalOcean.

### AI Response
Estimated approximately $65/month but overlooked the HA control-plane cost.

### What We Did With It
- Found the additional approximately $40/month charge on the DigitalOcean billing page and
  checked the provider documentation.
- Chose to keep the cluster running through grading to avoid disrupting the deployment.
