export interface DepartmentSettingsSaveOperation {
  readonly id: string;
  readonly label: string;
  readonly save: () => Promise<void>;
}

export class DepartmentSettingsSaveError extends Error {
  constructor(
    readonly operationId: string,
    readonly cause: unknown,
    message: string,
  ) {
    super(message, { cause });
    this.name = "DepartmentSettingsSaveError";
  }
}

export const saveDepartmentSettings = async (
  operations: readonly DepartmentSettingsSaveOperation[],
): Promise<void> => {
  for (const operation of operations) {
    try {
      await operation.save();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DepartmentSettingsSaveError(
        operation.id,
        error,
        `${operation.label} could not be saved: ${message}`,
      );
    }
  }
};
