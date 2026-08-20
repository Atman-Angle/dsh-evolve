/**
 * Audit module entry (v0.2 release hardening).
 *
 * @module dsh-evolve/audit
 */

export type { AuditCheck, AuditReport, AuditScope, AuditVerdict, AuditContext } from './contracts.js'
export { scanPrivileges, auditPrivilege, type PrivilegeFinding } from './privilege.js'
export { inventoryWriteSites, checkPathTraversal, auditFilesystem } from './filesystem.js'
export { inventoryNetworkSites, auditNetwork } from './network.js'
export { runLifecycleLoop, checkUninstall, auditLifecycle } from './lifecycle.js'
export { runNonInterference, trajectoryMetrics, auditNonInterference } from './non-interference.js'
export { auditFailureIsolation, type IsolationScenario } from './failure-isolation.js'
export { runPrivacyAdversarial, adversarialSessionEvents, auditPrivacy } from './privacy.js'
export { runSupplyChain, auditSupplyChain } from './supply-chain.js'
export { runSkillSecurity, auditSkillSecurity } from './skill-security.js'
export { runAudit, renderAuditReport, writeAuditReport, runScopeChecks, detectDshVersion } from './report.js'
