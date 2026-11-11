# 🔐 Render Environment Variables Setup

សូមបន្ថែម Environment Variables ខាងក្រោមនៅក្នុង **Render Dashboard → Your Service → Environment**:

```bash
# Bakong Open API (NBC Cambodia) - KHQR Dynamic Payment
BAKONG_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkYXRhIjp7ImlkIjoiZDQwYzIzYzMzNmFiNDZlOSJ9LCJpYXQiOjE3OTQzMTM0MjAsImV4cCI6MTgwMjA4OTQyMH0.EaPQgGSmBsf88_iscpIP9z5_56psfV8_roEHBNS29GU
BAKONG_ACCOUNT_ID=002111782@abaa
BAKONG_MERCHANT_NAME=VEASNA CHAN
BAKONG_MERCHANT_CITY=Phnom Penh
```

## ការពន្យល់៖
- **BAKONG_TOKEN**: JWT Token ចេញដោយ NBC Bakong (សុពលភាពដល់ឆ្នាំ 2027)
- **BAKONG_ACCOUNT_ID**: គណនី Bakong ID របស់លោកអ្នក (002111782@abaa)
- **BAKONG_MERCHANT_NAME**: ឈ្មោះពាណិជ្ជករលើ KHQR (VEASNA CHAN)
- **BAKONG_MERCHANT_CITY**: ទីក្រុង (Phnom Penh)

រួចរាល់! ប្រព័ន្ធនឹង Auto-Generate KHQR + Auto-Verify Payment ដោយស្វ័យប្រវត្តិ! 🎉
