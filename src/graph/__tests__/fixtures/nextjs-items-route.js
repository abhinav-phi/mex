export const DELETE = async (request: Request): Promise<Response> => {
  return new Response(null, { status: 204 });
};

export function HEAD(): Response {
  return new Response(null);
}
