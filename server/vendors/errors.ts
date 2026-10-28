/** An error from a vendor's API whose message is safe to show to admins. */
export class VendorApiError extends Error {
  constructor(
    public code: number | null,
    message: string,
    public httpStatus?: number,
  ) {
    super(message)
  }
}
