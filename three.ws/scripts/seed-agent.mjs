import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error('Set DATABASE_URL to your Neon connection string before running.');
	process.exit(1);
}
const sql = neon(DATABASE_URL);

const [user] = await sql`
	INSERT INTO users (email, display_name, email_verified)
	VALUES ('support@three.ws', 'Seed User', true)
	ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
	RETURNING id
`;

const [agent] = await sql`
	INSERT INTO agent_identities (user_id, name, description, home_url, persona_prompt)
	VALUES (${user.id}, 'Demo Agent', 'Seed agent for dev harness testing', 'https://three.ws', 'You are a helpful and friendly 3D agent.')
	RETURNING id
`;

console.log('user_id: ', user.id);
console.log('agent_id:', agent.id);
