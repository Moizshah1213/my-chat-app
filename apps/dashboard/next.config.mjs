/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/v1/:path*',
        destination: 'https://api.130.210.12.123.sslip.io/v1/:path*',
      },
    ];
  },
};

export default nextConfig;