// A separate database, so running the tests never touches development data.
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? "postgresql://lanternly:lanternly@127.0.0.1:5432/lanternly_test";
