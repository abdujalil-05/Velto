import { SetMetadata } from '@nestjs/common';

export const ALLOW_DURING_MAINTENANCE_KEY = 'allowDuringMaintenance';

/** Lets a mutating route (login, refresh, logout) through while READ_ONLY_MODE is on. */
export const AllowDuringMaintenance = () => SetMetadata(ALLOW_DURING_MAINTENANCE_KEY, true);
