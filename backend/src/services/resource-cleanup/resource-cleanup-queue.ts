import { TDbClient } from "@app/db";
import { TAuditLogDALFactory } from "@app/ee/services/audit-log/audit-log-dal";
import { TAuditLogServiceFactory } from "@app/ee/services/audit-log/audit-log-types";
import { TScepTransactionDALFactory } from "@app/ee/services/pki-scep/pki-scep-transaction-dal";
import { TScimServiceFactory } from "@app/ee/services/scim/scim-types";
import { TSnapshotDALFactory } from "@app/ee/services/secret-snapshot/snapshot-dal";
import { TKeyValueStoreDALFactory } from "@app/keystore/key-value-store-dal";
import { getConfig } from "@app/lib/config/env";
import { logger } from "@app/lib/logger";
import { JOB_SCHEDULER_PREFIX, QueueJobs, QueueName, TQueueServiceFactory } from "@app/queue";
import { TUserNotificationDALFactory } from "@app/services/notification/user-notification-dal";

import { TApprovalRequestDALFactory, TApprovalRequestGrantsDALFactory } from "../approval-policy/approval-request-dal";
import { TCertificateRequestDALFactory } from "../certificate-request/certificate-request-dal";
import { TIdentityAccessTokenDALFactory } from "../identity-access-token/identity-access-token-dal";
import { TIdentityUaClientSecretDALFactory } from "../identity-ua/identity-ua-client-secret-dal";
import { TOrgServiceFactory } from "../org/org-service";
import { TSecretVersionDALFactory } from "../secret/secret-version-dal";
import { TSecretFolderVersionDALFactory } from "../secret-folder/secret-folder-version-dal";
import { TSecretSharingDALFactory } from "../secret-sharing/secret-sharing-dal";
import { TSecretVersionV2DALFactory } from "../secret-v2-bridge/secret-version-dal";
import { TServiceTokenServiceFactory } from "../service-token/service-token-service";

type TDailyResourceCleanUpQueueServiceFactoryDep = {
  db: TDbClient;
  auditLogDAL: Pick<TAuditLogDALFactory, "pruneAuditLog">;
  auditLogService: Pick<TAuditLogServiceFactory, "checkPostgresAuditLogVolumeMigrationAlert">;
  identityAccessTokenDAL: Pick<TIdentityAccessTokenDALFactory, "removeExpiredTokens">;
  identityUniversalAuthClientSecretDAL: Pick<TIdentityUaClientSecretDALFactory, "removeExpiredClientSecrets">;
  secretVersionDAL: Pick<TSecretVersionDALFactory, "pruneExcessVersions">;
  secretVersionV2DAL: Pick<TSecretVersionV2DALFactory, "pruneExcessVersions">;
  secretFolderVersionDAL: Pick<TSecretFolderVersionDALFactory, "pruneExcessVersions">;
  snapshotDAL: Pick<TSnapshotDALFactory, "pruneExcessSnapshots">;
  secretSharingDAL: Pick<TSecretSharingDALFactory, "pruneExpiredSharedSecrets" | "pruneExpiredSecretRequests">;
  serviceTokenService: Pick<TServiceTokenServiceFactory, "notifyExpiringTokens">;
  queueService: TQueueServiceFactory;
  orgService: TOrgServiceFactory;
  userNotificationDAL: Pick<TUserNotificationDALFactory, "pruneNotifications">;
  keyValueStoreDAL: Pick<TKeyValueStoreDALFactory, "pruneExpiredKeys">;
  scimService: Pick<TScimServiceFactory, "notifyExpiringTokens">;
  approvalRequestDAL: Pick<TApprovalRequestDALFactory, "markExpiredRequests">;
  approvalRequestGrantsDAL: Pick<TApprovalRequestGrantsDALFactory, "markExpiredGrants">;
  certificateRequestDAL: Pick<TCertificateRequestDALFactory, "markExpiredApprovalRequests">;
  scepTransactionDAL: Pick<TScepTransactionDALFactory, "pruneExpiredTransactions">;
};

export type TDailyResourceCleanUpQueueServiceFactory = ReturnType<typeof dailyResourceCleanUpQueueServiceFactory>;

export const dailyResourceCleanUpQueueServiceFactory = ({
  db,
  auditLogDAL,
  auditLogService,
  queueService,
  snapshotDAL,
  secretVersionDAL,
  secretFolderVersionDAL,
  secretSharingDAL,
  secretVersionV2DAL,
  identityAccessTokenDAL,
  identityUniversalAuthClientSecretDAL,
  serviceTokenService,
  scimService,
  orgService,
  userNotificationDAL,
  keyValueStoreDAL,
  approvalRequestDAL,
  approvalRequestGrantsDAL,
  certificateRequestDAL,
  scepTransactionDAL
}: TDailyResourceCleanUpQueueServiceFactoryDep) => {
  const appCfg = getConfig();

  if (appCfg.isDailyResourceCleanUpDevelopmentMode) {
    logger.warn("Daily Resource Clean Up is in development mode.");
  }

  const runDailyCleanup = async () => {
    logger.info(`${QueueName.DailyResourceCleanUp}: cleanup task started`);
    await identityUniversalAuthClientSecretDAL.removeExpiredClientSecrets();
    await secretSharingDAL.pruneExpiredSharedSecrets();
    await secretSharingDAL.pruneExpiredSecretRequests();
    await snapshotDAL.pruneExcessSnapshots();
    await secretVersionDAL.pruneExcessVersions();
    await secretVersionV2DAL.pruneExcessVersions();
    await secretFolderVersionDAL.pruneExcessVersions();
    await serviceTokenService.notifyExpiringTokens();
    await scimService.notifyExpiringTokens();
    await orgService.notifyInvitedUsers();
    await auditLogService.checkPostgresAuditLogVolumeMigrationAlert();
    await userNotificationDAL.pruneNotifications();
    await keyValueStoreDAL.pruneExpiredKeys();
    await scepTransactionDAL.pruneExpiredTransactions();
    const expiredApprovalRequestIds = await approvalRequestDAL.markExpiredRequests();
    if (expiredApprovalRequestIds.length > 0) {
      await certificateRequestDAL.markExpiredApprovalRequests(expiredApprovalRequestIds);
    }
    await approvalRequestGrantsDAL.markExpiredGrants();
    await auditLogDAL.pruneAuditLog();
    logger.info(`${QueueName.DailyResourceCleanUp}: cleanup task completed`);
  };

  const runHourlyCleanup = async () => {
    logger.info(`${QueueName.FrequentResourceCleanUp}: cleanup task started`);
    await identityAccessTokenDAL.removeExpiredTokens();
    logger.info(`${QueueName.FrequentResourceCleanUp}: cleanup task completed`);
  };

  const init = async () => {
    if (appCfg.isSecondaryInstance) {
      return;
    }

    queueService.start(QueueName.DailyResourceCleanUp, async () => {
      try {
        await runDailyCleanup();
      } catch (error) {
        logger.error(error, `${QueueName.DailyResourceCleanUp}: resource cleanup failed`);
        throw error;
      }
    });

    await queueService.upsertJobScheduler(
      QueueName.DailyResourceCleanUp,
      `${JOB_SCHEDULER_PREFIX}:${QueueJobs.DailyResourceCleanUp}`,
      { pattern: appCfg.isDailyResourceCleanUpDevelopmentMode ? "*/5 * * * *" : "0 0 * * *" },
      { name: QueueJobs.DailyResourceCleanUp }
    );

    // Hourly cleanup routine
    queueService.start(QueueName.FrequentResourceCleanUp, async () => {
      try {
        await runHourlyCleanup();
      } catch (error) {
        logger.error(error, `${QueueName.FrequentResourceCleanUp}: resource cleanup failed`);
        throw error;
      }
    });

    await queueService.upsertJobScheduler(
      QueueName.FrequentResourceCleanUp,
      `${JOB_SCHEDULER_PREFIX}:${QueueJobs.FrequentResourceCleanUp}`,
      { pattern: appCfg.isDailyResourceCleanUpDevelopmentMode ? "*/5 * * * *" : "0 * * * *" },
      { name: QueueJobs.FrequentResourceCleanUp }
    );
  };

  const getDbSize = async () => {
    const dbSizeResult = await db.raw<{
      rows: { databaseBytes: string; databasePretty: string }[];
    }>(
      `SELECT pg_database_size(current_database())::text AS "databaseBytes",
              pg_size_pretty(pg_database_size(current_database())) AS "databasePretty"`
    );
    const tableResult = await db.raw<{
      rows: {
        schema: string;
        name: string;
        totalBytes: string;
        totalPretty: string;
        rowCount: string;
      }[];
    }>(
      `SELECT n.nspname AS "schema",
              c.relname AS "name",
              pg_total_relation_size(c.oid)::text AS "totalBytes",
              pg_size_pretty(pg_total_relation_size(c.oid)) AS "totalPretty",
              c.reltuples::bigint::text AS "rowCount"
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r'
         AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       ORDER BY pg_total_relation_size(c.oid) DESC
       LIMIT 30`
    );
    return {
      databaseBytes: dbSizeResult.rows[0].databaseBytes,
      databasePretty: dbSizeResult.rows[0].databasePretty,
      tables: tableResult.rows
    };
  };

  return {
    init,
    runDailyCleanup,
    runHourlyCleanup,
    getDbSize
  };
};
