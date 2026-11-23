import { migrate, openDatabase } from './database.ts';

const connection = process.env.DATABASE_URL;
if (!connection) throw new Error('DATABASE_URL is required');
const database = openDatabase(connection);
try {
  await migrate(database);
  console.log('Database migrations applied');
} finally {
  await database.end();
}
